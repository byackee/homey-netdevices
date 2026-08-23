/**
 * PowerNet (APC) — `1.3.6.1.4.1.318.1.1.1`.
 *
 * Le repli quand la RFC 1628 manque. APC est le parc installé le plus large, et beaucoup
 * de ses cartes — surtout les Back-UPS et les Smart-UPS d'avant les cartes AP9631 —
 * n'implémentent **que** cette branche privée.
 *
 * 🔴 La singularité qui coûte cher : **APC signale l'absence par une valeur sentinelle,
 * pas par `noSuchObject`.** L'agent répond, la lecture réussit, et la valeur est une
 * borne d'entier. Sans traitement, l'app affiche « 4294967295 minutes restantes » —
 * soit un peu plus de quatre-vingt-un ans d'autonomie. Voir
 * {@link APC_TEMPERATURE_UNSUPPORTED} et {@link APC_TIMETICKS_UNSUPPORTED}.
 *
 * Deuxième singularité, moins dangereuse mais aussi trompeuse : **APC publie deux fois
 * les mêmes mesures**, une version entière et une version « haute précision » en
 * dixièmes. Confondre les deux donne une charge de 873 % (annexe A §2).
 *
 * OID vérifiés sur le MIB PowerNet officiel (annexe A §2). Tous scalaires : le `.0` final
 * est inclus ici, une fois pour toutes.
 */

const BASE = '1.3.6.1.4.1.318.1.1.1';

export const APC_UPS_OID = {
  // --- Identité `.1` -------------------------------------------------------
  /** upsBasicIdentModel — « Smart-UPS 750 », etc. */
  basicIdentModel: `${BASE}.1.1.1.0`,
  /** upsAdvIdentFirmwareRevision — firmware, pas numéro de série. */
  advIdentFirmwareRevision: `${BASE}.1.2.1.0`,

  // --- Batterie `.2` -------------------------------------------------------
  /** upsBasicBatteryStatus — voir {@link APC_BATTERY_STATUS}. */
  basicBatteryStatus: `${BASE}.2.1.1.0`,
  /** upsAdvBatteryCapacity — % **direct**, entier. */
  advBatteryCapacity: `${BASE}.2.2.1.0`,
  /** upsAdvBatteryTemperature — °C. 🔴 `255` = **non supporté**, pas 255 °C. */
  advBatteryTemperature: `${BASE}.2.2.2.0`,
  /**
   * upsAdvBatteryRunTimeRemaining — autonomie.
   *
   * 🔴 En `TimeTicks`, donc en **centièmes de seconde** : `÷6000` pour des minutes.
   * 🔴 `4294967295` = non supporté.
   */
  advBatteryRunTimeRemaining: `${BASE}.2.2.3.0`,
  /** upsHighPrecBatteryCapacity — 🔴 **dixièmes de %**. Préféré quand il répond. */
  highPrecBatteryCapacity: `${BASE}.2.3.1.0`,

  // --- Entrée `.3` ---------------------------------------------------------
  /** upsAdvInputLineVoltage — V **entiers**, pas des dixièmes. */
  advInputLineVoltage: `${BASE}.3.2.1.0`,

  // --- Sortie `.4` ---------------------------------------------------------
  /** upsBasicOutputStatus — 🔴 **28 valeurs**. Voir {@link APC_OUTPUT_STATUS}. */
  basicOutputStatus: `${BASE}.4.1.1.0`,
  /** upsAdvOutputLoad — % de la puissance nominale, entier. */
  advOutputLoad: `${BASE}.4.2.3.0`,
  /** upsHighPrecOutputLoad — 🔴 **dixièmes de %**. */
  highPrecOutputLoad: `${BASE}.4.3.3.0`,
} as const;

/**
 * 🔴 La sentinelle de température : `255` veut dire « cet onduleur n'a pas de sonde ».
 *
 * Une vraie batterie à 255 °C n'existe pas — elle a fondu bien avant. Mais 255 est un
 * entier parfaitement valide, il traverse toutes les bornes plausibles d'un `INTEGER`,
 * et rien dans la réponse SNMP ne le distingue d'une mesure.
 */
export const APC_TEMPERATURE_UNSUPPORTED = 255;

/**
 * 🔴 La sentinelle des `TimeTicks` : `4294967295` = 2³²−1 = « non supporté ».
 *
 * Sans traitement : 715 827 minutes restantes, soit quatre-vingt-un ans. Le chiffre est
 * si absurde qu'on croit à un bug d'affichage — c'est ce qui le rend coûteux à trouver.
 */
export const APC_TIMETICKS_UNSUPPORTED = 4_294_967_295;

/** `upsBasicBatteryStatus`. */
export const APC_BATTERY_STATUS = {
  unknown: 1,
  batteryNormal: 2,
  batteryLow: 3,
  batteryInFaultCondition: 4,
  noBatteryPresent: 5,
} as const;

/**
 * `upsBasicOutputStatus` — **28 valeurs**, contre 7 à `upsOutputSource` de la RFC.
 *
 * APC distingue des modes que la RFC ignore : l'éco-mode, le spot mode, la double
 * conversion, le hot standby. C'est plus riche, et c'est justement le problème : exposé
 * tel quel, `ups_status` aurait 28 valeurs chez APC et 7 ailleurs, et aucune Flow écrite
 * pour un onduleur ne marcherait sur l'autre. Le repli sur le vocabulaire commun a lieu
 * dans `apc-reader.mts`.
 */
export const APC_OUTPUT_STATUS = {
  unknown: 1,
  onLine: 2,
  onBattery: 3,
  onSmartBoost: 4,
  timedSleeping: 5,
  softwareBypass: 6,
  off: 7,
  rebooting: 8,
  switchedBypass: 9,
  hardwareFailureBypass: 10,
  sleepingUntilPowerReturn: 11,
  onSmartTrim: 12,
  ecoMode: 13,
  hotStandby: 14,
  onBatteryTest: 15,
  emergencyStaticBypass: 16,
  staticBypassStandby: 17,
  powerSavingMode: 18,
  spotMode: 19,
  eConversion: 20,
  chargerSpotmode: 21,
  inverterSpotmode: 22,
  activeLoad: 23,
  batteryDischargeSpotmode: 24,
  inverterStandby: 25,
  chargerOnly: 26,
  distributedEnergyReserve: 27,
  selfTest: 28,
} as const;

export type ApcOutputStatus = keyof typeof APC_OUTPUT_STATUS;

/**
 * Les états où la charge est réellement portée par la batterie **à cause d'un test**,
 * pas d'une coupure.
 *
 * Ils comptent pour `ups_status`, qui doit dire la vérité sur d'où vient le courant,
 * mais **pas** pour `alarms.onBattery`, qui déclenche les Flows de coupure. Un test de
 * batterie hebdomadaire programmé par l'utilisateur ne doit pas éteindre ses appareils
 * non essentiels à trois heures du matin.
 */
export const APC_TEST_STATUSES = [
  APC_OUTPUT_STATUS.onBatteryTest,
  APC_OUTPUT_STATUS.selfTest,
] as const;
