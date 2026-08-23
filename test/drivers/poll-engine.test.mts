import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { UpsLive } from '../../lib/ups/snapshot.mjs';
import {
  ANY_STATUS,
  ContactTracker,
  DETAIL_RHYTHM,
  FAILURES_BEFORE_VERDICT,
  LIVE_RHYTHM,
  LIVE_UNKNOWN,
  PollGate,
  UpsChangeDetector,
  intervalMs,
  matchesStatusFilter,
} from '../../drivers/ups/poll-engine.mjs';

/** Construit un relevé rapide, alarmes toutes retombées sauf mention contraire. */
function live(patch: Partial<Omit<UpsLive, 'alarms'>> & { alarms?: Partial<UpsLive['alarms']> } = {}): UpsLive {
  const { alarms, ...rest } = patch;
  return {
    status: 'normal',
    batteryCharge: 87.5,
    runtimeMinutes: 25,
    load: 23.5,
    ...rest,
    alarms: {
      onBattery: false,
      batteryLow: false,
      overload: false,
      replaceBattery: false,
      ...alarms,
    },
  };
}

const ON_BATTERY = live({ status: 'battery', alarms: { onBattery: true } });

// ---------------------------------------------------------------------------
// Les deux rythmes
// ---------------------------------------------------------------------------

test('garde-fou : les quatre bornes des deux rythmes sont deux à deux distinctes', () => {
  // Sans cela, la suite entière resterait verte si les deux groupes partageaient un
  // plancher ou un défaut — exactement le piège du §8.5 : une garantie qu'aucun test
  // n'épingle parce que toutes les fixtures valent la même chose.
  const bornes = [
    LIVE_RHYTHM.defaultSeconds, LIVE_RHYTHM.minSeconds,
    DETAIL_RHYTHM.defaultSeconds, DETAIL_RHYTHM.minSeconds,
  ];
  assert.equal(new Set(bornes).size, bornes.length, 'deux bornes confondues rendent un échange invisible');
  assert.ok(LIVE_RHYTHM.defaultSeconds < DETAIL_RHYTHM.minSeconds,
    'le rythme rapide doit rester sous le plancher du lent, sinon l\'un peut se faire passer pour l\'autre');
});

test('le rythme rapide vaut ~10 s par défaut et ne descend pas sous son plancher', () => {
  assert.equal(intervalMs(undefined, LIVE_RHYTHM), 10_000);
  assert.equal(intervalMs(30, LIVE_RHYTHM), 30_000);
  assert.equal(intervalMs(1, LIVE_RHYTHM), 5_000);
});

test('le rythme lent vaut ~5 min par défaut, avec un plancher bien plus haut', () => {
  assert.equal(intervalMs(undefined, DETAIL_RHYTHM), 300_000);
  assert.equal(intervalMs(10, DETAIL_RHYTHM), 60_000,
    '10 s est légitime pour le groupe rapide et absurde pour le lent : les planchers ne se partagent pas');
});

test('un réglage illisible retombe sur le défaut, jamais sur NaN', () => {
  // setTimeout(NaN) tire immédiatement et en boucle : un réglage mal saisi deviendrait
  // une tempête de requêtes SNMP.
  for (const mauvais of ['', 'dix', null, NaN, -5, 0]) {
    assert.equal(intervalMs(mauvais, LIVE_RHYTHM), 10_000, `réglage rejeté : ${String(mauvais)}`);
  }
});

// ---------------------------------------------------------------------------
// La garde de réentrance
// ---------------------------------------------------------------------------

test('un relevé lent ne se superpose pas au précédent', async () => {
  const gate = new PollGate();
  let running = 0;
  let maxParallel = 0;
  let skipped = 0;

  const job = async () => {
    running += 1;
    maxParallel = Math.max(maxParallel, running);
    await new Promise((r) => setTimeout(r, 10));
    running -= 1;
  };

  const first = gate.run(job);
  const second = gate.run(job);
  if (!(await second)) skipped += 1;
  await first;

  assert.equal(maxParallel, 1);
  assert.equal(skipped, 1, 'le tick concurrent doit être sauté, pas empilé');
  assert.equal(gate.running, false);
});

test('la garde se relâche même si le relevé lève', async () => {
  const gate = new PollGate();
  await assert.rejects(gate.run(async () => { throw new Error('timeout SNMP'); }));
  assert.equal(gate.running, false, 'une garde restée fermée gèle le device pour de bon');
  assert.equal(await gate.run(async () => {}), true);
});

test('les deux groupes ont chacun leur garde : le lent ne bloque pas le rapide', async () => {
  const slow = new PollGate();
  const fast = new PollGate();
  const inFlight = slow.run(() => new Promise((r) => setTimeout(r, 20)));

  assert.equal(await fast.run(async () => {}), true,
    'le relevé rapide porte la valeur du produit, il ne doit jamais attendre le lent');
  await inFlight;
});

// ---------------------------------------------------------------------------
// §3.8 — les deux pertes de contact
// ---------------------------------------------------------------------------

test('deux échecs sont absorbés en silence, sans rien écrire', () => {
  const tracker = new ContactTracker();
  tracker.succeeded(live());

  for (let n = 1; n < FAILURES_BEFORE_VERDICT; n += 1) {
    const out = tracker.failed();
    assert.equal(out.reason, 'absorbing');
    assert.equal(out.live, null, 'sous le seuil, on ne conclut rien donc on n\'écrit rien');
    assert.equal(out.availability, 'available');
    assert.equal(out.contactLostDuringOutage, false);
  }
});

test('injoignable depuis un état normal : indisponible, et l\'état devient « inconnu »', () => {
  const tracker = new ContactTracker();
  tracker.succeeded(live());

  let out = tracker.failed();
  out = tracker.failed();
  out = tracker.failed();

  assert.equal(out.reason, 'unreachable');
  assert.equal(out.availability, 'unavailable');
  assert.equal(out.failures, FAILURES_BEFORE_VERDICT);
  assert.equal(out.contactLostDuringOutage, false, 'ce n\'est pas une coupure, c\'est une panne de lien');
  assert.deepEqual(out.live, LIVE_UNKNOWN);
});

test('🔴 injoignable ne pose jamais 0 : les mesures repartent à null', () => {
  // Le piège du §8.5. 0 % de batterie lève alarm_battery ET alarm_ups_onbattery :
  // une fausse alerte de coupure de courant, en pleine nuit.
  assert.equal(LIVE_UNKNOWN.batteryCharge, null);
  assert.equal(LIVE_UNKNOWN.runtimeMinutes, null);
  assert.equal(LIVE_UNKNOWN.load, null);
  assert.equal(LIVE_UNKNOWN.status, 'unknown', '« inconnu » ne doit pas se déguiser en « normal » ni en « éteint »');
  assert.deepEqual(LIVE_UNKNOWN.alarms,
    { onBattery: false, batteryLow: false, overload: false, replaceBattery: false },
    'une alarme qu\'on ne sait pas lire n\'est pas une alarme qui sonne');
});

test('🔴 §3.8 : contact perdu alors qu\'on était sur batterie ⇒ l\'état reste figé', () => {
  const tracker = new ContactTracker();
  tracker.succeeded(ON_BATTERY);

  tracker.failed();
  tracker.failed();
  const out = tracker.failed();

  assert.equal(out.reason, 'lost-during-outage');
  assert.equal(out.live, null,
    'écrire quoi que ce soit ici prétendrait savoir ce que fait l\'onduleur pendant que le NAS est éteint');
  assert.equal(out.contactLostDuringOutage, true);
  assert.equal(tracker.lastStatus, 'battery', 'le dernier état connu ne s\'efface pas avec le contact');
});

test('le déclencheur de coupure part une seule fois, pas à chaque tick suivant', () => {
  const tracker = new ContactTracker();
  tracker.succeeded(ON_BATTERY);

  const annonces: boolean[] = [];
  for (let n = 0; n < 10; n += 1) annonces.push(tracker.failed().contactLostDuringOutage);

  assert.deepEqual(annonces.filter(Boolean).length, 1,
    'un NAS éteint reste éteint des heures : à 10 s cela ferait 360 notifications par heure');
  assert.equal(annonces.indexOf(true), FAILURES_BEFORE_VERDICT - 1, 'et elle part au franchissement du seuil');
});

test('le retour du NAS réarme le déclencheur pour la coupure suivante', () => {
  const tracker = new ContactTracker();
  tracker.succeeded(ON_BATTERY);
  for (let n = 0; n < 5; n += 1) tracker.failed();

  const back = tracker.succeeded(live());
  assert.equal(back.reason, 'ok');
  assert.equal(back.availability, 'available');
  assert.equal(back.failures, 0);

  tracker.succeeded(ON_BATTERY);
  tracker.failed(); tracker.failed();
  assert.equal(tracker.failed().contactLostDuringOutage, true);
});

test('une perte de contact avant tout relevé réussi n\'est pas une coupure', () => {
  // lastStatus vaut null, pas 'battery' : au premier démarrage sur une mauvaise adresse,
  // on ne doit pas annoncer une coupure de courant imaginaire.
  const tracker = new ContactTracker();
  tracker.failed(); tracker.failed();
  const out = tracker.failed();

  assert.equal(out.reason, 'unreachable');
  assert.equal(out.contactLostDuringOutage, false);
});

test('un état dégradé qui n\'est pas « battery » suit le chemin ordinaire', () => {
  for (const status of ['bypass', 'booster', 'reducer', 'off', 'unknown'] as const) {
    const tracker = new ContactTracker();
    tracker.succeeded(live({ status }));
    tracker.failed(); tracker.failed();
    const out = tracker.failed();
    assert.equal(out.reason, 'unreachable', `${status} ne fige pas l'état`);
  }
});

// ---------------------------------------------------------------------------
// La détection de changement
// ---------------------------------------------------------------------------

test('le premier relevé ne rejoue pas « l\'état a changé »', () => {
  const detector = new UpsChangeDetector();
  const first = detector.observe(live());
  assert.equal(first.statusChanged, false, 'sinon chaque redémarrage de l\'app rejoue un changement fantôme');
  assert.equal(first.wentOnBattery, false);
  assert.equal(first.mainsRestored, false);
});

test('démarrer alors que l\'onduleur est déjà sur batterie déclenche quand même', () => {
  // Choix inverse du précédent, et assumé : c'est le déclencheur qui coupe les appareils
  // non essentiels. Le rejouer une fois de trop coûte moins cher que de le manquer.
  const detector = new UpsChangeDetector();
  assert.equal(detector.observe(ON_BATTERY).wentOnBattery, true);
});

test('passage sur batterie puis retour secteur : un front chacun, pas plus', () => {
  const detector = new UpsChangeDetector();
  detector.observe(live());

  const down = detector.observe(ON_BATTERY);
  assert.equal(down.wentOnBattery, true);
  assert.equal(down.statusChanged, true);
  assert.equal(down.status, 'battery');

  const still = detector.observe(ON_BATTERY);
  assert.equal(still.wentOnBattery, false, 'une coupure qui dure ne se re-déclenche pas toutes les 10 s');
  assert.equal(still.statusChanged, false);

  const up = detector.observe(live());
  assert.equal(up.mainsRestored, true);
  assert.equal(up.wentOnBattery, false);
});

test('les alarmes partent sur front montant seulement', () => {
  const detector = new UpsChangeDetector();
  detector.observe(live());

  const raised = detector.observe(live({
    alarms: { batteryLow: true, overload: true, replaceBattery: true },
  }));
  assert.equal(raised.batteryLowRaised, true);
  assert.equal(raised.overloadRaised, true);
  assert.equal(raised.replaceBatteryRaised, true);

  const held = detector.observe(live({
    alarms: { batteryLow: true, overload: true, replaceBattery: true },
  }));
  assert.equal(held.batteryLowRaised, false,
    'une batterie à remplacer le reste des semaines : notifier à chaque relevé serait intenable');
  assert.equal(held.overloadRaised, false);
  assert.equal(held.replaceBatteryRaised, false);
});

test('le franchissement d\'autonomie se juge par Flow, sur deux bornes connues', () => {
  const detector = new UpsChangeDetector();
  detector.observe(live({ runtimeMinutes: 20 }));
  const change = detector.observe(live({ runtimeMinutes: 4 }));

  assert.equal(change.runtimeBefore, 20);
  assert.equal(change.runtimeAfter, 4);
  // Deux Flows, deux seuils, une seule lecture SNMP.
  assert.equal(UpsChangeDetector.crossedBelow(change, 5), true);
  assert.equal(UpsChangeDetector.crossedBelow(change, 30), false, '20 était déjà sous 30 : pas un franchissement');
  assert.equal(UpsChangeDetector.crossedBelow(change, 2), false);
});

test('rester sous le seuil ne re-déclenche pas', () => {
  const detector = new UpsChangeDetector();
  detector.observe(live({ runtimeMinutes: 4 }));
  const change = detector.observe(live({ runtimeMinutes: 3 }));
  assert.equal(UpsChangeDetector.crossedBelow(change, 5), false);
});

test('🔴 une autonomie inconnue ne franchit aucun seuil', () => {
  const detector = new UpsChangeDetector();
  detector.observe(live({ runtimeMinutes: 20 }));
  const perdue = detector.observe(live({ runtimeMinutes: null }));
  assert.equal(UpsChangeDetector.crossedBelow(perdue, 5), false,
    'on n\'éteint pas un NAS sur ce qu\'on ne sait pas');

  const detector2 = new UpsChangeDetector();
  const premier = detector2.observe(live({ runtimeMinutes: 3 }));
  assert.equal(UpsChangeDetector.crossedBelow(premier, 5), false,
    'sans borne de départ, il n\'y a pas de franchissement, seulement un état');
});

test('une autonomie réellement à 0 franchit bien, elle', () => {
  const detector = new UpsChangeDetector();
  detector.observe(live({ runtimeMinutes: 8 }));
  const change = detector.observe(live({ runtimeMinutes: 0 }));
  assert.equal(UpsChangeDetector.crossedBelow(change, 5), true, '0 est une mesure, null est une absence');
});

test('reset coupe la comparaison avec l\'appareil d\'avant', () => {
  const detector = new UpsChangeDetector();
  detector.observe(ON_BATTERY);
  detector.reset();
  assert.equal(detector.observe(live()).mainsRestored, false,
    'changer d\'adresse ne veut pas dire que le courant est revenu');
});

// ---------------------------------------------------------------------------
// Le filtre du déclencheur « l'état passe à X »
// ---------------------------------------------------------------------------

test('« n\'importe quel état » accepte les sept valeurs du vocabulaire', () => {
  // Le Flow le plus courant est celui-là. S'il ne part jamais, rien ne le signale :
  // un déclencheur muet ressemble à un onduleur qui n'a rien à dire.
  for (const status of ['normal', 'battery', 'bypass', 'booster', 'reducer', 'off', 'unknown'] as const) {
    assert.equal(matchesStatusFilter(ANY_STATUS, status), true, status);
  }
});

test('un état choisi ne laisse passer que lui', () => {
  assert.equal(matchesStatusFilter('battery', 'battery'), true);
  assert.equal(matchesStatusFilter('battery', 'normal'), false);
});

test('un sélecteur absent ne laisse rien passer, plutôt que tout', () => {
  // `args.status === state.status` avec deux undefined rendrait vrai : la carte partirait
  // à chaque changement d'état, pour tous les Flows, quel que soit leur réglage.
  assert.equal(matchesStatusFilter(undefined, 'battery'), false);
  assert.equal(matchesStatusFilter(null, 'battery'), false);
});
