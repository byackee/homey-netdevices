/**
 * Tampon de traces circulaire et borné.
 *
 * Il existe **dès le premier commit**, pas après la première panne (plan §8.3).
 * Raison : une app Homey installée par CLI n'a aucun log lisible. Sur les trois
 * apps précédentes, c'est ce tampon — servi par `GET /trace` — qui a localisé
 * *chaque* panne, parce qu'il est seul à distinguer « le driver n'a rien envoyé »
 * de « la vue n'a rien affiché ».
 *
 * Trois contraintes, toutes dictées par le fait qu'il tourne en permanence dans
 * une app à la mémoire contrainte :
 *
 * 1. **Borné.** Un tableau qui grandit sans fin est une fuite déguisée en journal.
 *    Anneau à capacité fixe : la plus vieille entrée cède la place, et le nombre
 *    d'entrées perdues est compté pour que l'absence soit visible.
 * 2. **Sans rétention d'objets.** Le détail est sérialisé et tronqué *à l'insertion*.
 *    Garder la référence d'un objet applicatif dans un tampon de 500 entrées, c'est
 *    maintenir en vie tout ce qu'il pointe.
 * 3. **Ne lève jamais.** Un journal qui fait tomber ce qu'il observe est pire que
 *    pas de journal — référence circulaire, getter qui explose, BigInt : tout est
 *    avalé et remplacé par un marqueur.
 */

export type TraceLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TraceEntry {
  /** Horodatage epoch en millisecondes. */
  at: number;
  level: TraceLevel;
  /** D'où ça vient : `scan`, `ups:192.168.1.20`, `api`… */
  scope: string;
  message: string;
  /** Détail déjà sérialisé et tronqué ; absent quand l'appelant n'en a pas donné. */
  detail?: string;
}

/** Assez pour couvrir plusieurs cycles de relevé sans peser sur la mémoire de Homey. */
const DEFAULT_CAPACITY = 500;

/** Au-delà, un détail informe moins qu'il n'encombre. */
const MAX_DETAIL_CHARS = 500;

/**
 * Réduit une valeur quelconque à une chaîne courte, sans jamais lever.
 *
 * Une `Error` est réduite à son message : la pile d'une app Homey pointe vers du
 * code transpilé et n'apprend rien de plus que le message.
 */
function formatDetail(detail: unknown): string {
  let text: string;
  try {
    if (detail instanceof Error) text = `${detail.name}: ${detail.message}`;
    else if (typeof detail === 'string') text = detail;
    else if (detail === null) text = 'null';
    else if (typeof detail === 'bigint') text = `${detail}n`;
    else if (typeof detail === 'object') text = JSON.stringify(detail, jsonSafe()) ?? String(detail);
    else text = String(detail);
  } catch (error) {
    text = `<not serialisable: ${(error as Error).message}>`;
  }
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}

/**
 * Remplaçant JSON qui survit aux cycles, aux Buffer et aux BigInt.
 *
 * Le tampon est instancié **à chaque sérialisation** : un `WeakSet` partagé entre
 * deux traces signalerait comme « cycle » un objet simplement réutilisé.
 *
 * On lit `this[key]` et pas seulement `value`, parce que `JSON.stringify` applique
 * `toJSON()` *avant* d'appeler le remplaçant : un Buffer serait déjà devenu
 * `{"type":"Buffer","data":[159,120,4]}`, illisible et démesuré. Le holder, lui,
 * porte encore l'objet d'origine.
 */
function jsonSafe(): (this: unknown, key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return function replacer(this: unknown, key: string, value: unknown): unknown {
    const holder = this as Record<string, unknown> | undefined;
    const raw = holder === undefined ? value : holder[key];
    if (Buffer.isBuffer(raw)) return `<Buffer ${raw.toString('hex')}>`;
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '<cycle>';
      seen.add(value);
    }
    return value;
  };
}

export interface TraceBufferOptions {
  capacity?: number;
  /** Horloge injectable : un test ne doit pas dépendre de l'heure qu'il est. */
  now?: () => number;
}

/**
 * Anneau d'entrées horodatées, du plus ancien au plus récent.
 */
export class TraceBuffer {
  private readonly slots: (TraceEntry | undefined)[];
  private readonly now: () => number;
  /** Index d'écriture suivant, modulo la capacité. */
  private cursor = 0;
  /** Nombre total d'entrées écrites depuis toujours, débordements compris. */
  private written = 0;

  constructor(options: TraceBufferOptions = {}) {
    const capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_CAPACITY));
    this.slots = new Array<TraceEntry | undefined>(capacity);
    this.now = options.now ?? (() => Date.now());
  }

  get capacity(): number {
    return this.slots.length;
  }

  /** Entrées écrasées faute de place. Non nul veut dire : il manque le début. */
  get dropped(): number {
    return Math.max(0, this.written - this.slots.length);
  }

  /** Entrées actuellement retenues. */
  get size(): number {
    return Math.min(this.written, this.slots.length);
  }

  record(level: TraceLevel, scope: string, message: string, detail?: unknown): void {
    const entry: TraceEntry = { at: this.now(), level, scope, message };
    if (detail !== undefined) entry.detail = formatDetail(detail);
    this.slots[this.cursor] = entry;
    this.cursor = (this.cursor + 1) % this.slots.length;
    this.written += 1;
  }

  debug(scope: string, message: string, detail?: unknown): void {
    this.record('debug', scope, message, detail);
  }

  info(scope: string, message: string, detail?: unknown): void {
    this.record('info', scope, message, detail);
  }

  warn(scope: string, message: string, detail?: unknown): void {
    this.record('warn', scope, message, detail);
  }

  error(scope: string, message: string, detail?: unknown): void {
    this.record('error', scope, message, detail);
  }

  /**
   * Les entrées retenues, **de la plus ancienne à la plus récente**.
   *
   * Copie défensive : ce que sert `GET /trace` ne doit pas pouvoir modifier le tampon.
   */
  entries(): TraceEntry[] {
    const out: TraceEntry[] = [];
    const kept = this.size;
    const start = this.written <= this.slots.length ? 0 : this.cursor;
    for (let i = 0; i < kept; i += 1) {
      const entry = this.slots[(start + i) % this.slots.length];
      if (entry !== undefined) out.push({ ...entry });
    }
    return out;
  }

  /** Rendu texte, une ligne par entrée — la forme qu'on colle dans un ticket de support. */
  toText(): string {
    const lines = this.entries().map((e) => {
      const stamp = new Date(e.at).toISOString();
      const head = `${stamp} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.message}`;
      return e.detail === undefined ? head : `${head} — ${e.detail}`;
    });
    const dropped = this.dropped;
    if (dropped > 0) lines.unshift(`... ${dropped} older entr${dropped === 1 ? 'y' : 'ies'} lost`);
    return lines.join('\n');
  }

  clear(): void {
    this.slots.fill(undefined);
    this.cursor = 0;
    this.written = 0;
  }
}

/**
 * Le tampon partagé de l'app : `api.mts` le sert sur `GET /trace`, tout le reste y écrit.
 *
 * Un singleton se justifie ici parce que la valeur du journal tient précisément à ce
 * que le driver, le balayage et l'API écrivent dans **le même** ordre chronologique.
 */
export const trace = new TraceBuffer();
