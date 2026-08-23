/**
 * Le driver onduleur.
 *
 * Il ne relève rien : chaque appareil s'interroge lui-même (plan §4.2). Ce qui vit ici,
 * c'est ce qui est **commun à tous les appareils du driver** — les écouteurs des cartes
 * Flow, qu'il faut enregistrer une seule fois par driver et non une fois par appareil.
 *
 * Le pairing appartient au lot 6. Il tient à un balayage de sous-réseau mis en cache au
 * niveau app (plan §3.7), qui n'existe pas encore ; ce driver n'en propose donc pas, ce
 * qui vaut mieux qu'un assistant qui s'ouvre sur une liste vide sans expliquer pourquoi.
 */

import Homey from 'homey';

import { UpsChangeDetector, matchesStatusFilter, type UpsChangeSet } from './poll-engine.mjs';
import type UpsDevice from './device.mjs';

export default class UpsDriver extends Homey.Driver {
  override async onInit(): Promise<void> {
    this.registerStatusTrigger();
    this.registerRuntimeTrigger();
    this.registerConditions();
    this.registerActions();
  }

  /** « L'état passe à X » — le sélecteur filtre, l'appareil ne connaît pas les Flows. */
  private registerStatusTrigger(): void {
    this.homey.flow
      .getDeviceTriggerCard('ups_status_changed')
      .registerRunListener(async (args: { status?: string }, state: UpsChangeSet) =>
        matchesStatusFilter(args.status, state.status));
  }

  /**
   * « L'autonomie descend sous X minutes ».
   *
   * Le franchissement se juge **ici**, à partir des deux bornes portées par l'état de
   * l'événement, parce que le seuil appartient à chaque Flow : deux Flows réglés à 15 et
   * à 5 minutes doivent tous deux partir au bon moment sur un seul relevé SNMP. Un
   * franchissement, pas un état : rester quinze minutes sous le seuil ne redéclenche rien.
   */
  private registerRuntimeTrigger(): void {
    this.homey.flow
      .getDeviceTriggerCard('ups_runtime_below')
      .registerRunListener(async (args: { minutes?: number }, state: UpsChangeSet) => {
        const threshold = Number(args.minutes);
        if (!Number.isFinite(threshold)) return false;
        return UpsChangeDetector.crossedBelow(state, threshold);
      });
  }

  /**
   * Les conditions numériques rendent **faux** sur une mesure inconnue.
   *
   * C'est le sens de la condition qui l'impose : « l'autonomie est supérieure à 10 min »
   * doit protéger un arrêt propre. Répondre « oui » parce qu'on n'a pas su lire, ou
   * traiter le `null` comme un 0, revient dans les deux cas à décider à l'aveugle.
   */
  private registerConditions(): void {
    this.homey.flow
      .getConditionCard('ups_is_on_battery')
      .registerRunListener(async (args: { device: UpsDevice }) => args.device.isOnBattery());

    this.homey.flow
      .getConditionCard('ups_runtime_above')
      .registerRunListener(async (args: { device: UpsDevice; minutes?: number }) => {
        const runtime = args.device.measured('runtime');
        return runtime !== null && runtime > Number(args.minutes);
      });

    this.homey.flow
      .getConditionCard('ups_battery_above')
      .registerRunListener(async (args: { device: UpsDevice; percent?: number }) => {
        const charge = args.device.measured('battery');
        return charge !== null && charge > Number(args.percent);
      });
  }

  /**
   * La seule action de la v1, et elle est en lecture.
   *
   * 🔴 Pas de « lancer un test de batterie », pas d'« éteindre » : `upsControl` de la
   * RFC 1628 couperait l'alimentation de tout ce qui est branché sur l'onduleur, et
   * `upsTestDeepBatteryCalibration` use la batterie à chaque exécution (plan §3.6).
   */
  private registerActions(): void {
    this.homey.flow
      .getActionCard('ups_refresh')
      .registerRunListener(async (args: { device: UpsDevice }) => {
        await args.device.refreshNow();
      });
  }
}
