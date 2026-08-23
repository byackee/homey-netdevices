import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  FAILURES_BEFORE_VERDICT,
  HostContactTracker,
  NAS_DETAIL_RHYTHM,
  NAS_LIVE_RHYTHM,
  NasChangeDetector,
  NasVolumeDetector,
  PollGate,
  fullestVolume,
  intervalMs,
} from '../../lib/nas/poll-engine.mjs';
import type { NasLive, NasVolume } from '../../lib/nas/snapshot.mjs';

function live(overrides: Partial<NasLive> = {}): NasLive {
  return { uptimeDays: 1.5, cpuLoad: 28.5, cpuCount: 4, memoryUsedPercent: 85, ...overrides };
}

function volume(key: string, usedPercent: number | null): NasVolume {
  return { key, label: `/${key}`, usedPercent, sizeBytes: 1_000, usedBytes: 500 };
}

// ---------------------------------------------------------------------------
// Les rythmes
// ---------------------------------------------------------------------------

test('🔴 les quatre bornes des deux rythmes sont deux à deux distinctes', () => {
  // Un test qui les confond — ou un refactor qui partagerait un plancher entre les deux
  // groupes — se voit ici et nulle part ailleurs.
  const bounds = [
    NAS_LIVE_RHYTHM.defaultSeconds, NAS_LIVE_RHYTHM.minSeconds,
    NAS_DETAIL_RHYTHM.defaultSeconds, NAS_DETAIL_RHYTHM.minSeconds,
  ];
  assert.equal(new Set(bounds).size, bounds.length, `des bornes convergent : ${bounds.join(', ')}`);
});

test('🔴 le rythme de l\'hôte est bien plus lent que celui de l\'onduleur', () => {
  // `hrProcessorLoad` est une moyenne sur la dernière minute : la relire toutes les dix
  // secondes rendrait six fois la même valeur, en payant six fois le prix — sur la
  // machine même dont on mesure la charge.
  assert.ok(NAS_LIVE_RHYTHM.minSeconds >= 15, 'aucun réglage sous 15 s n\'apprend quoi que ce soit');
  assert.equal(NAS_LIVE_RHYTHM.defaultSeconds, 60);
  // Le relevé lent parcourt deux tables entières là où le rapide émet un seul `get` :
  // même à son réglage le plus fréquent, il doit rester plus rare que le rapide à son
  // réglage par défaut.
  assert.ok(NAS_DETAIL_RHYTHM.minSeconds > NAS_LIVE_RHYTHM.defaultSeconds,
    'le relevé coûteux peut devenir plus fréquent que le relevé bon marché');
});

test('intervalMs borne le réglage, et un réglage aberrant retombe sur le défaut', () => {
  // `setTimeout(NaN)` tire immédiatement et en boucle : un réglage mal saisi
  // deviendrait une tempête de requêtes SNMP.
  assert.equal(intervalMs(120, NAS_LIVE_RHYTHM), 120_000);
  assert.equal(intervalMs(1, NAS_LIVE_RHYTHM), 15_000, 'ramené au plancher');
  assert.equal(intervalMs('', NAS_LIVE_RHYTHM), 60_000, 'un réglage vide retombe sur le défaut');
  assert.equal(intervalMs('abc', NAS_DETAIL_RHYTHM), 900_000);
  assert.equal(intervalMs(999_999, NAS_DETAIL_RHYTHM), 86_400_000, 'ramené au plafond');
});

test('PollGate refuse un second passage tant que le premier court', async () => {
  const gate = new PollGate();
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });

  const first = gate.run(() => held);
  const second = await gate.run(async () => { throw new Error('n\'aurait pas dû tourner'); });
  assert.equal(second, false);

  release();
  assert.equal(await first, true);
});

// ---------------------------------------------------------------------------
// Le suivi de contact
// ---------------------------------------------------------------------------

test('un relevé réussi rend l\'appareil disponible et publie ce qu\'il a lu', () => {
  const tracker = new HostContactTracker();
  const outcome = tracker.succeeded(live());
  assert.equal(outcome.reason, 'ok');
  assert.equal(outcome.availability, 'available');
  assert.deepEqual(outcome.live, live());
});

test('🔴 sous le seuil, on n\'écrit rien du tout', () => {
  // SNMP est de l'UDP : un datagramme perdu n'est pas une panne, et faire clignoter la
  // tuile à chaque paquet égaré la rendrait illisible.
  const tracker = new HostContactTracker();
  tracker.succeeded(live());

  for (let attempt = 1; attempt < FAILURES_BEFORE_VERDICT; attempt += 1) {
    const outcome = tracker.failed();
    assert.equal(outcome.reason, 'absorbing', `échec ${attempt}`);
    assert.equal(outcome.live, null, 'une écriture a eu lieu sous le seuil');
    assert.equal(outcome.availability, 'available');
  }
});

test('🔴 au seuil, tout repart à null — jamais à zéro', () => {
  // Zéro afficherait un NAS au repos avec des disques vides au moment précis où il ne
  // répond plus.
  const tracker = new HostContactTracker();
  tracker.succeeded(live());
  for (let i = 1; i < FAILURES_BEFORE_VERDICT; i += 1) tracker.failed();

  const outcome = tracker.failed();
  assert.equal(outcome.reason, 'unreachable');
  assert.equal(outcome.availability, 'unavailable');
  assert.deepEqual(outcome.live, { uptimeDays: null, cpuLoad: null, cpuCount: 0, memoryUsedPercent: null });
});

test('🔴 il n\'y a pas de gel ici, et c\'est délibéré', () => {
  // Le §3.8 gèle l'état de l'onduleur parce que le NAS qui le relaie s'éteint PENDANT la
  // coupure qu'il sert à détecter. Un hôte injoignable n'a pas d'équivalent : sa charge
  // CPU d'il y a un quart d'heure ne dit rien de maintenant.
  const tracker = new HostContactTracker();
  tracker.succeeded(live({ cpuLoad: 99 }));
  for (let i = 1; i < FAILURES_BEFORE_VERDICT; i += 1) tracker.failed();
  assert.equal(tracker.failed().live?.cpuLoad, null, 'la dernière valeur a été gelée');
});

test('un relevé réussi après une panne remet le compteur et la disponibilité', () => {
  const tracker = new HostContactTracker();
  for (let i = 0; i < FAILURES_BEFORE_VERDICT + 2; i += 1) tracker.failed();
  const outcome = tracker.succeeded(live());
  assert.equal(outcome.availability, 'available');
  assert.equal(outcome.failures, 0);
  assert.equal(tracker.failed().reason, 'absorbing', 'le compteur n\'est pas reparti de zéro');
});

test('🔴 reset() ne garde pas l\'indisponibilité de l\'ancienne adresse', () => {
  // C'est le défaut n°4 de la revue, transposé : sans la remise à `true`, le premier
  // échec sur la NOUVELLE adresse annoncerait « indisponible » dès le stade `absorbing`,
  // c'est-à-dire conclurait sur le nouvel hôte à partir des échecs de l'ancien.
  const tracker = new HostContactTracker();
  for (let i = 0; i < FAILURES_BEFORE_VERDICT; i += 1) tracker.failed();

  tracker.reset();
  const outcome = tracker.failed();
  assert.equal(outcome.reason, 'absorbing', 'les échecs d\'avant ont survécu au changement d\'adresse');
  assert.equal(outcome.availability, 'available');
});

// ---------------------------------------------------------------------------
// Le redémarrage
// ---------------------------------------------------------------------------

test('un uptime qui recule est un redémarrage', () => {
  const detector = new NasChangeDetector();
  detector.observe(live({ uptimeDays: 12.4 }));
  const change = detector.observe(live({ uptimeDays: 0.1 }));
  assert.equal(change.rebooted, true);
  assert.equal(change.uptimeBefore, 12.4);
  assert.equal(change.uptimeAfter, 0.1);
});

test('🔴 le tout premier relevé n\'annonce pas de redémarrage', () => {
  // Il n'y a rien à comparer, et un « votre NAS a redémarré » à chaque redémarrage de
  // l'app Homey serait faux tous les jours sauf un.
  const detector = new NasChangeDetector();
  assert.equal(detector.observe(live({ uptimeDays: 0.02 })).rebooted, false);
});

test('un uptime qui avance, ou qui devient inconnu, n\'est pas un redémarrage', () => {
  const detector = new NasChangeDetector();
  detector.observe(live({ uptimeDays: 3 }));
  assert.equal(detector.observe(live({ uptimeDays: 3.1 })).rebooted, false);
  assert.equal(detector.observe(live({ uptimeDays: null })).rebooted, false,
    'une mesure perdue n\'est pas un redémarrage');
  assert.equal(detector.observe(live({ uptimeDays: 3.2 })).rebooted, false,
    'et le retour de la mesure n\'en est pas un non plus');
});

test('reset() efface la comparaison : une autre machine n\'a pas redémarré', () => {
  const detector = new NasChangeDetector();
  detector.observe(live({ uptimeDays: 400 }));
  detector.reset();
  assert.equal(detector.observe(live({ uptimeDays: 0.5 })).rebooted, false);
});

// ---------------------------------------------------------------------------
// Le remplissage des volumes
// ---------------------------------------------------------------------------

test('🔴 un volume vu pour la première fois ne déclenche rien', () => {
  // On ne réveille pas quelqu'un à trois heures du matin parce qu'un volume déjà plein
  // depuis six mois vient d'être vu pour la première fois.
  const detector = new NasVolumeDetector();
  assert.deepEqual(detector.observe([volume('volume1', 98)]), []);
});

test('un volume qui se remplit produit ses deux bornes', () => {
  const detector = new NasVolumeDetector();
  detector.observe([volume('volume1', 78)]);
  const crossings = detector.observe([volume('volume1', 82)]);

  assert.equal(crossings.length, 1);
  assert.deepEqual(crossings[0], { key: 'volume1', label: '/volume1', before: 78, after: 82 });
});

test('🔴 le seuil appartient à chaque Flow, pas à l\'appareil', () => {
  // Deux Flows réglés à 80 % et à 95 % doivent tous deux partir au bon moment sur un
  // seul relevé SNMP. Le détecteur expose les bornes ; la carte tranche.
  const crossing = { key: 'volume1', label: '/volume1', before: 78, after: 82 };
  assert.equal(NasVolumeDetector.crossedAbove(crossing, 80), true);
  assert.equal(NasVolumeDetector.crossedAbove(crossing, 95), false);
  assert.equal(NasVolumeDetector.crossedAbove(crossing, 70), false, 'déjà franchi avant');
});

test('🔴 un franchissement, pas un état : rester au-dessus ne redéclenche rien', () => {
  const detector = new NasVolumeDetector();
  detector.observe([volume('volume1', 78)]);
  const first = detector.observe([volume('volume1', 82)]);
  const second = detector.observe([volume('volume1', 84)]);

  assert.equal(NasVolumeDetector.crossedAbove(first[0]!, 80), true);
  assert.equal(NasVolumeDetector.crossedAbove(second[0]!, 80), false,
    'rester trois semaines au-dessus du seuil rejouerait la carte à chaque relevé');
});

test('crossedAbove refuse un seuil illisible et une borne inconnue', () => {
  assert.equal(NasVolumeDetector.crossedAbove(
    { key: 'v', label: '/v', before: null, after: 99 }, 80), false);
  assert.equal(NasVolumeDetector.crossedAbove(
    { key: 'v', label: '/v', before: 10, after: 99 }, Number.NaN), false);
});

test('un volume démonté puis remonté repart sans « avant »', () => {
  // Se comparer à une valeur d'il y a trois semaines produirait un franchissement
  // fantôme au remontage.
  const detector = new NasVolumeDetector();
  detector.observe([volume('volume1', 40)]);
  detector.observe([]);
  assert.deepEqual(detector.observe([volume('volume1', 95)]), []);
});

test('un volume qui se vide ne déclenche rien', () => {
  const detector = new NasVolumeDetector();
  detector.observe([volume('volume1', 91)]);
  assert.deepEqual(detector.observe([volume('volume1', 40)]), []);
});

test('un volume sans pourcentage est ignoré au lieu d\'être compté pour zéro', () => {
  const detector = new NasVolumeDetector();
  detector.observe([volume('volume1', 91)]);
  assert.deepEqual(detector.observe([volume('volume1', null)]), []);
  // Et il n'a pas été mémorisé à `null` : au retour de la mesure, il repart sans avant.
  assert.deepEqual(detector.observe([volume('volume1', 99)]), []);
});

test('plusieurs volumes qui montent produisent une carte chacun', () => {
  const detector = new NasVolumeDetector();
  detector.observe([volume('root', 50), volume('volume1', 70)]);
  const crossings = detector.observe([volume('root', 51), volume('volume1', 91)]);
  assert.deepEqual(crossings.map((entry) => entry.key), ['root', 'volume1']);
});

// ---------------------------------------------------------------------------

test('🔴 fullestVolume rend null quand rien n\'est lisible, jamais « il reste de la place »', () => {
  // La condition sert à protéger une sauvegarde : répondre « oui » parce qu'on n'a pas
  // su lire revient à décider à l'aveugle.
  assert.equal(fullestVolume([]), null);
  assert.equal(fullestVolume([volume('cdrom', null)]), null);
});

test('fullestVolume retient le plus rempli', () => {
  const volumes = [volume('root', 50), volume('volume1', 92), volume('backup', 10), volume('cdrom', null)];
  assert.equal(fullestVolume(volumes)?.key, 'volume1');
});

test('fullestVolume traite un volume vide comme une mesure, pas comme une absence', () => {
  assert.equal(fullestVolume([volume('neuf', 0)])?.usedPercent, 0);
});
