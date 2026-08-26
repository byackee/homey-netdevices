import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';

/**
 * Ce que la relecture du store refuse, et que `homey app validate` ne voit jamais.
 *
 * 🔴 Athom livre sa grille de relecture dans le SDK —
 * `node_modules/homey-lib/lib/AIReviewer/data/{checklist,guidelines}.md` — mais le CLI ne
 * l'exécute pas. Une app peut donc valider `--level publish` sans une erreur et se faire
 * rejeter à la certification. C'est arrivé : la v1.0.6 est partie en relecture avec
 * l'icône du driver onduleur comme icône d'app.
 */

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const md5 = (p: string) => createHash('md5').update(readFileSync(join(root, p))).digest('hex');

const DRIVERS = readdirSync(join(root, 'drivers'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

test('🔴 l’icône de l’app n’est celle d’aucun driver', () => {
  // checklist.md : « App icon cannot be the same as a driver icon — reject. »
  const app = md5('assets/icon.svg');
  for (const d of DRIVERS) {
    const p = `drivers/${d}/assets/icon.svg`;
    if (!existsSync(join(root, p))) continue;
    assert.notEqual(md5(p), app, `assets/icon.svg est identique à ${p}`);
  }
});

test('🔴 les icônes des drivers sont distinctes entre elles', () => {
  const vues = new Map<string, string>();
  for (const d of DRIVERS) {
    const p = `drivers/${d}/assets/icon.svg`;
    if (!existsSync(join(root, p))) continue;
    const h = md5(p);
    const deja = vues.get(h);
    assert.equal(deja, undefined, `${p} est identique à ${deja}`);
    vues.set(h, p);
  }
});

test('🔴 le README reste court et n’énumère pas les fonctionnalités', () => {
  // guidelines.md : « one to two paragraphs maximum » et « Do not list all the different
  // features, capabilities, and Flow cards available ».
  for (const f of ['README.txt', 'README.fr.txt', 'README.nl.txt']) {
    const texte = read(f).trim();
    const paragraphes = texte.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
    assert.ok(paragraphes.length <= 2, `${f} : ${paragraphes.length} paragraphes`);

    // Une section en capitales est le signe d'un README qui redevient une brochure.
    const sections = texte.split('\n').filter((l) => /^[A-Z][A-Z ]{4,}$/.test(l.trim()));
    assert.deepEqual(sections, [], `${f} porte des sections : ${sections.join(', ')}`);
  }
});

test('🔴 le README est traduit partout où la description l’est', () => {
  // homey/lib/App.js attend `README.<code>.txt`. guidelines.md : « if the description is
  // translated to a language, the readme should also be translated ».
  const compose = JSON.parse(read('.homeycompose/app.json'));
  for (const langue of Object.keys(compose.description ?? {})) {
    const f = langue === 'en' ? 'README.txt' : `README.${langue}.txt`;
    assert.ok(existsSync(join(root, f)), `${f} manque alors que description.${langue} existe`);
  }
});

/**
 * 🔴 Une liste déroulante de **carte de Flow** veut `title` ; seuls les **réglages**
 * veulent `label`. Le schéma d'Athom n'a d'`additionalProperties: false` nulle part, si
 * bien qu'un `label` sur une carte est avalé en silence : la liste s'affiche alors avec
 * des identifiants bruts (`lowerLayerDown`), y compris sur la carte qui coupe un port.
 * Trois listes du driver switch étaient dans ce cas.
 */
test('🔴 les listes déroulantes des cartes de Flow portent title, jamais label', () => {
  const app = JSON.parse(read('app.json'));
  const cartes = [
    ...(app.flow?.triggers ?? []),
    ...(app.flow?.conditions ?? []),
    ...(app.flow?.actions ?? []),
  ];
  assert.ok(cartes.length > 0, 'aucune carte lue — le test ne prouverait rien');

  for (const carte of cartes) {
    for (const arg of carte.args ?? []) {
      if (arg.type !== 'dropdown') continue;
      assert.ok(arg.title, `${carte.id}/${arg.name} : argument sans title`);
      for (const v of arg.values ?? []) {
        assert.ok(v.title, `${carte.id}/${arg.name} valeur « ${v.id} » : title manquant`);
        assert.equal(v.label, undefined, `${carte.id}/${arg.name} valeur « ${v.id} » : label est ignoré ici`);
      }
    }
  }
});

test('🔴 toute clé de traduction appelée par une vue existe dans les trois langues', () => {
  // Le helper `t()` des vues retombe sur son littéral anglais quand la clé manque, si
  // bien qu'une absence ne casse rien et ne se voit pas : un utilisateur fr ou nl lit
  // simplement de l'anglais au milieu d'une vue traduite.
  const langues = ['en', 'fr', 'nl'] as const;
  const locales = Object.fromEntries(
    langues.map((l) => [l, JSON.parse(read(`locales/${l}.json`))]),
  );

  const porte = (d: unknown, chemin: string): boolean => {
    let cur: unknown = d;
    for (const part of chemin.split('.')) {
      if (typeof cur !== 'object' || cur === null || !(part in cur)) return false;
      cur = (cur as Record<string, unknown>)[part];
    }
    return true;
  };

  const vues: string[] = [];
  for (const d of DRIVERS) {
    for (const sous of ['pair', 'repair']) {
      const dir = join(root, 'drivers', d, sous);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.html'))) {
        vues.push(join('drivers', d, sous, f));
      }
    }
  }
  assert.ok(vues.length > 0, 'aucune vue trouvée — le test ne prouverait rien');

  for (const vue of vues) {
    // Un point dans la clé : c'est ce qui distingue `pair.probing` d'un `emit('adopted')`,
    // que le motif attraperait sinon par le `t` final de « emit ».
    const appels = [...read(vue).matchAll(/t\('([a-z0-9_]+\.[a-z0-9_.]+)'/g)].map((m) => m[1]!);
    for (const cle of new Set(appels)) {
      for (const l of langues) {
        assert.ok(porte(locales[l], cle), `${vue} appelle « ${cle} », absente de ${l}.json`);
      }
    }
  }
});

/**
 * 🔴 Le rejet de la 1.0.10, point 1 : « Your app's name contains the protocol name
 * SNMP, please change your app's name. »
 *
 * guidelines.md 1.1 énumère Zigbee, Z-Wave, 433 MHz, Infrared, BLE, Thread et
 * Matter, et la relecture a appliqué la même règle à SNMP : la liste est un
 * exemple, pas une énumération close. Le nom de protocole reste bienvenu dans la
 * description et dans les mots-clés — c'est là que la recherche du store le lit —
 * mais pas dans le nom.
 */
const PROTOCOLES = [
  'snmp', 'zigbee', 'z-wave', 'zwave', '433', 'infrared', 'ble', 'bluetooth',
  'thread', 'matter', 'mqtt', 'modbus', 'knx', 'upnp', 'http', 'tcp', 'udp',
];

test('🔴 le nom de l’app ne porte aucun nom de protocole', () => {
  const noms = JSON.parse(read('.homeycompose/app.json')).name as Record<string, string>;
  assert.ok(Object.keys(noms).length > 0, 'aucun nom lu — le test ne prouverait rien');

  for (const [langue, nom] of Object.entries(noms)) {
    const mots = nom.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
    for (const p of PROTOCOLES) {
      assert.ok(!mots.includes(p), `name.${langue} « ${nom} » porte le protocole « ${p} »`);
    }
    // checklist.md : « "Homey" and "Athom" in the app name is not allowed. »
    for (const marque of ['homey', 'athom']) {
      assert.ok(!mots.includes(marque), `name.${langue} « ${nom} » porte la marque « ${marque} »`);
    }
    // checklist.md : « Names of 5 or more words are not allowed. »
    const compte = nom.trim().split(/\s+/).filter((m) => m !== '-' && m !== '–').length;
    assert.ok(compte <= 4, `name.${langue} « ${nom} » fait ${compte} mots`);
  }
});

/**
 * 🔴 Le rejet de la 1.0.10, point 2 : « Your NAS and switch driver images do not
 * have a white or transparent background. »
 *
 * La règle s'inverse d'un jeu d'images à l'autre, et c'est le piège :
 *   - driver  → checklist.md « on a **white or transparent** background » ;
 *   - app     → checklist.md « White or transparent backgrounds are **not allowed**. »
 * Corriger les images de driver en teintant celles de l'app du même coup ferait
 * repartir l'app en relecture sur l'autre moitié de la même ligne.
 *
 * On lit la bordure et non toute l'image : le fond est ce qui touche le bord, et
 * l'appareil, lui, est censé être au centre.
 */
async function bordure(chemin: string): Promise<{ blanc: boolean; transparent: boolean; exemple: string }> {
  const { data, info } = await sharp(join(root, chemin))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const pixel = (x: number, y: number) => {
    const i = (y * width + x) * channels;
    return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!] as const;
  };

  const anneau: (readonly number[])[] = [];
  for (let x = 0; x < width; x += 1) anneau.push(pixel(x, 0), pixel(x, height - 1));
  for (let y = 0; y < height; y += 1) anneau.push(pixel(0, y), pixel(width - 1, y));

  // Une tolérance, pas une égalité : le rendu antialiase le bord et une bordure
  // strictement 255 casserait au premier pixel adouci.
  const estBlanc = (p: readonly number[]) => p[0]! >= 246 && p[1]! >= 246 && p[2]! >= 246;
  const estTransparent = (p: readonly number[]) => p[3]! <= 8;

  const fautif = anneau.find((p) => !estBlanc(p) && !estTransparent(p)) ?? anneau[0]!;
  return {
    blanc: anneau.every(estBlanc),
    transparent: anneau.every(estTransparent),
    exemple: `rgba(${fautif.join(', ')})`,
  };
}

test('🔴 les images de driver sont sur fond blanc ou transparent', async () => {
  let lues = 0;
  for (const d of DRIVERS) {
    for (const taille of ['small', 'large', 'xlarge']) {
      const p = `drivers/${d}/assets/images/${taille}.png`;
      if (!existsSync(join(root, p))) continue;
      const b = await bordure(p);
      assert.ok(b.blanc || b.transparent, `${p} : fond ni blanc ni transparent — ${b.exemple}`);
      lues += 1;
    }
  }
  assert.ok(lues > 0, 'aucune image de driver lue — le test ne prouverait rien');
});

test('🔴 les images de l’app ne sont ni blanches ni transparentes', async () => {
  // L'autre moitié de la même ligne de checklist. Sans ce test, la correction du
  // rejet ci-dessus se propage naturellement aux images de l'app et les casse.
  const images = ['small', 'large', 'xlarge']
    .map((taille) => `assets/images/${taille}.png`)
    .filter((p) => existsSync(join(root, p)));
  assert.ok(images.length > 0, 'aucune image d’app lue — le test ne prouverait rien');

  for (const p of images) {
    const b = await bordure(p);
    assert.ok(!b.blanc, `${p} : fond blanc, refusé pour une image d’app`);
    assert.ok(!b.transparent, `${p} : fond transparent, refusé pour une image d’app`);
  }
});

/**
 * 🔴 Le retour de relecture, point 3 : la page de réglages testait `result.ok` et
 * `result.reachable`, que `POST /probe` n'a jamais envoyés. Les deux valaient
 * toujours `undefined`, si bien que chaque test d'adresse tombait dans la branche
 * « n'a pas répondu du tout » — y compris pour un onduleur qui venait de donner son
 * modèle.
 *
 * Le relecteur n'a vu qu'une occurrence ; il y en avait trois. Le balayage de la
 * même page lisait `status.devices` et `status.reachableWithoutSnmp` là où
 * `GET /scan` renvoie `found` et `others`, et concluait « rien n'a répondu en
 * SNMP » sur un sous-réseau qui venait de répondre. Les deux noms fautifs ne sont
 * pas inventés : ils appartiennent au contrat des vues de pairing, où ils sont
 * justes. C'est un idiome recopié d'un contrat vers un autre.
 *
 * Rien ne pouvait le signaler : la page est du JavaScript non typé que `tsc` ne
 * regarde pas, et une propriété absente ne lève rien. Ce garde rapproche donc les
 * deux côtés de *chaque* contrat, en lisant les interfaces déclarées dans
 * `api.mts`.
 */

/** Les champs déclarés par une interface de réponse d'`api.mts`. */
function champsDe(interfaceNom: string): Set<string> {
  const bloc = read('api.mts').match(new RegExp(`interface ${interfaceNom} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(bloc, `${interfaceNom} introuvable dans api.mts`);
  const champs = new Set(
    [...bloc![1]!.matchAll(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\??:/gm)].map((m) => m[1]!),
  );
  assert.ok(champs.size > 0, `aucun champ lu dans ${interfaceNom} — le test ne prouverait rien`);
  return champs;
}

/**
 * La page, commentaires retirés : ils citent les champs fautifs pour expliquer le
 * bug, et un garde qui les lirait se déclencherait sur sa propre explication. Le
 * motif ne vise que les lignes entièrement commentées, seule forme employée par la
 * page — couper à un `//` en fin de ligne mutilerait les URL qu'elle contient.
 */
function pageDesReglages(): string {
  return read('settings/index.html')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(l))
    .join('\n');
}

test('🔴 la page de réglages ne lit que des champs que l’API renvoie', () => {
  // Chaque variable est le nom que la page donne à une réponse, et à une seule.
  const contrats: [string, string][] = [
    ['result', 'ProbeReply'],
    ['status', 'ScanReply'],
    ['data', 'TraceReply'],
  ];

  const page = pageDesReglages();
  let verifies = 0;

  for (const [variable, interfaceNom] of contrats) {
    const champs = champsDe(interfaceNom);
    const motif = new RegExp(`\\b${variable}\\.([a-zA-Z_][a-zA-Z0-9_]*)`, 'g');
    const lus = new Set([...page.matchAll(motif)].map((m) => m[1]!));
    assert.ok(lus.size > 0, `aucun accès à ${variable} lu — le test ne prouverait rien`);

    for (const champ of lus) {
      assert.ok(champs.has(champ), `settings/index.html lit ${variable}.${champ}, absent de ${interfaceNom}`);
      verifies += 1;
    }
  }

  assert.ok(verifies >= 6, `seulement ${verifies} champs vérifiés — le garde a perdu sa prise`);
});

/**
 * Les entrées que le balayage liste sont des `ScanEntry`, pas des `ProbeReply` :
 * le modèle et le nom y sont, le constructeur non. La page nomme l'entrée `e`
 * dans son gabarit de liste, et `entry` dans la fonction qui l'étiquette.
 */
test('🔴 le balayage n’étiquette ses trouvailles qu’avec des champs de ScanEntry', () => {
  const champs = champsDe('ScanEntry');
  const page = pageDesReglages();

  const lus = new Set([...page.matchAll(/\b(?:entry|e)\.([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]!));
  assert.ok(lus.size > 0, 'aucune étiquette de trouvaille lue — le test ne prouverait rien');

  for (const champ of lus) {
    assert.ok(champs.has(champ), `settings/index.html lit entry.${champ}, absent de ScanEntry`);
  }
});

/**
 * L'autre moitié du même contrat : lire le bon champ ne sert à rien si on le
 * compare à des valeurs que le verdict ne prend jamais. Les verdicts vivent dans
 * `ProbeOutcome`, côté app.
 */
test('🔴 la page de réglages compare outcome à des verdicts qui existent', () => {
  const bloc = read('app.mts').match(/export type ProbeOutcome =([\s\S]*?);/);
  assert.ok(bloc, 'ProbeOutcome introuvable dans app.mts');

  const verdicts = new Set([...bloc![1]!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!));
  // api.mts en ajoute un que l'app ne produit pas : l'adresse vide.
  verdicts.add('no-host');
  assert.ok(verdicts.size > 1, 'aucun verdict lu — le test ne prouverait rien');

  const compares = [...pageDesReglages().matchAll(/outcome === '([a-z-]+)'/g)].map((m) => m[1]!);
  assert.ok(compares.length > 0, 'la page ne compare aucun outcome');

  for (const v of compares) {
    assert.ok(verdicts.has(v), `settings/index.html teste outcome === '${v}', que ProbeOutcome ne produit pas`);
  }
});

/**
 * 🔴 Le renommage de la 1.0.11 a d'abord été fait à moitié : le manifeste disait
 * « Network Devices » pendant que `app.mts` journalisait encore « SNMP - Network
 * Devices app initialised » à chaque démarrage. Le test ci-dessus ne pouvait pas le
 * voir — il ne lisait que le manifeste — et c'est la pire moitié qui restait : le
 * journal est justement ce qu'un relecteur du store ouvre.
 *
 * Le garde ne vérifie pas que les copies sont à jour, il refuse les copies. Un nom
 * d'app recopié dans le code finit toujours par diverger du manifeste, et Homey
 * préfixe déjà chaque ligne de journal de l'id de l'app.
 */
test('🔴 le nom de l’app n’est recopié nulle part dans le code livré', () => {
  const nom = (JSON.parse(read('.homeycompose/app.json')).name as Record<string, string>).en;
  assert.ok(nom, 'nom anglais introuvable dans le manifeste');

  const livres: string[] = ['app.mts', 'api.mts', 'settings/index.html'];
  const balaye = (dossier: string, suffixes: string[]) => {
    for (const e of readdirSync(join(root, dossier), { withFileTypes: true })) {
      const chemin = `${dossier}/${e.name}`;
      if (e.isDirectory()) balaye(chemin, suffixes);
      else if (suffixes.some((s) => e.name.endsWith(s))) livres.push(chemin);
    }
  };
  balaye('lib', ['.mts']);
  balaye('drivers', ['.mts', '.html']);
  assert.ok(livres.length > 3, 'aucune source livrée balayée — le test ne prouverait rien');

  for (const f of livres) {
    // Les commentaires ont le droit de nommer l'app : c'est du texte pour le
    // lecteur du code, pas une chaîne qui sort de l'app.
    const code = read(f)
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(l))
      .join('\n');
    assert.ok(!code.includes(nom), `${f} recopie le nom de l’app « ${nom} »`);
  }
});
