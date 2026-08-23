# Annexe A — Référence OID vérifiée

Méthode : RFC 1628 / 3621 / 2863 récupérées en texte brut sur rfc-editor.org et lues ligne à ligne
(SYNTAX / MAX-ACCESS / `::= {...}`). PowerNet (APC), CPS (CyberPower), PDU2 (Raritan), EATON-EPDU
téléchargées depuis les dépôts MIB officiels. Pour Eaton, le MIB officiel et le code de
`jaroschek/home-assistant-eaton-epdu` donnent les mêmes OID — confirmation croisée.

Tout ce qui n'a pas été confirmé à une source primaire est marqué ⚠️.

---

## 1. UPS-MIB (RFC 1628) — `1.3.6.1.2.1.33` — **la base du driver v1**

### Identité `.1.1`
| nom | OID | type | acc |
|---|---|---|---|
| upsIdentManufacturer | .1.1.1.0 | DisplayString(0..31) | R |
| upsIdentModel | .1.1.2.0 | DisplayString(0..63) | R |
| upsIdentUPSSoftwareVersion | .1.1.3.0 | DisplayString | R |
| upsIdentAgentSoftwareVersion | .1.1.4.0 | DisplayString | R |
| upsIdentName | .1.1.5.0 | DisplayString | RW |
| upsIdentAttachedDevices | .1.1.6.0 | DisplayString | RW |

### Batterie `.1.2`
| nom | OID | type | unité | acc |
|---|---|---|---|---|
| upsBatteryStatus | .1.2.1.0 | INTEGER | énum | R |
| upsSecondsOnBattery | .1.2.2.0 | NonNegativeInteger | **secondes** | R |
| upsEstimatedMinutesRemaining | .1.2.3.0 | PositiveInteger | **minutes** | R |
| upsEstimatedChargeRemaining | .1.2.4.0 | INTEGER(0..100) | % | R |
| upsBatteryVoltage | .1.2.5.0 | NonNegativeInteger | **0,1 V** (décivolts) | R |
| upsBatteryCurrent | .1.2.6.0 | Integer32 **signé** | 0,1 A | R |
| upsBatteryTemperature | .1.2.7.0 | Integer32 | °C | R |

`upsBatteryStatus` : `unknown(1)`, `batteryNormal(2)`, `batteryLow(3)`, `batteryDepleted(4)`

### Entrée `.1.3` — table indexée par `upsInputLineIndex`
| nom | OID | unité |
|---|---|---|
| upsInputLineBads | .1.3.1.0 | Counter32 |
| upsInputNumLines | .1.3.2.0 | — |
| upsInputFrequency | .1.3.3.1.2.*n* | **0,1 Hz** |
| upsInputVoltage | .1.3.3.1.3.*n* | **V RMS entiers** |
| upsInputCurrent | .1.3.3.1.4.*n* | 0,1 A |
| upsInputTruePower | .1.3.3.1.5.*n* | W |

### Sortie `.1.4` — table indexée par `upsOutputLineIndex`
| nom | OID | unité |
|---|---|---|
| upsOutputSource | .1.4.1.0 | énum |
| upsOutputFrequency | .1.4.2.0 | **0,1 Hz** |
| upsOutputNumLines | .1.4.3.0 | — |
| upsOutputVoltage | .1.4.4.1.2.*n* | **V RMS entiers** |
| upsOutputCurrent | .1.4.4.1.3.*n* | 0,1 A |
| upsOutputPower | .1.4.4.1.4.*n* | W |
| upsOutputPercentLoad | .1.4.4.1.5.*n* | % (0..200) |

`upsOutputSource` : `other(1)`, `none(2)`, `normal(3)`, `bypass(4)`, `battery(5)`, `booster(6)`, `reducer(7)`
⇒ **c'est la source de vérité de la capability `ups_status`.**

### Alarmes `.1.6`
`upsAlarmsPresent` = `.1.6.1.0` (Gauge32) · `upsAlarmDescr` = `.1.6.2.1.2.n` (**un OID**, pas une valeur) ·
`upsAlarmTime` = `.1.6.2.1.3.n`

Alarmes bien connues, base `1.3.6.1.2.1.33.1.6.3` :
| # | alarme | # | alarme |
|---|---|---|---|
| .1 | BatteryBad | .13 | ChargerFailed |
| .2 | **OnBattery** | .14 | UpsOutputOff |
| .3 | **LowBattery** | .15 | UpsSystemOff |
| .4 | DepletedBattery | .16 | FanFailure |
| .5 | TempBad | .17 | FuseFailure |
| .6 | InputBad | .18 | GeneralFault |
| .7 | OutputBad | .19 | DiagnosticTestFailed |
| .8 | **OutputOverload** | .20 | CommunicationsLost |
| .9 | OnBypass | .21 | AwaitingPower |
| .10 | BypassBad | .22 | ShutdownPending |
| .11 | OutputOffAsRequested | .23 | ShutdownImminent |
| .12 | UpsOffAsRequested | .24 | TestInProgress |

### Test `.1.7` et Contrôle `.1.8` — **tout RW, hors v1**
`upsTestId` (.1.7.1.0, RW) — écrire un OID de `upsWellKnownTests` (`.1.7.7`) pour lancer :
QuickBatteryTest = `.7.4`, GeneralSystemsTest = `.7.3`, **DeepBatteryCalibration = `.7.5` ⚠️ décharge
profonde, use la batterie — ne jamais l'exposer sans avertissement explicite.**

`upsShutdownType` (.1.8.1.0) · `upsShutdownAfterDelay` (.1.8.2.0, s, 0=immédiat, -1=annule) ·
`upsStartupAfterDelay` (.1.8.3.0) · `upsRebootWithDuration` (.1.8.4.0, -1..300 s) · `upsAutoRestart` (.1.8.5.0)

⚠️ **Ce groupe peut couper l'alimentation de tout ce qui est branché sur l'onduleur.** S'il est un jour
exposé en Flow action, il lui faut un garde-fou explicite (confirmation dans les réglages du device).

### Traps `1.3.6.1.2.1.33.2`
OnBattery = `.2.1` · TestCompleted = `.2.2` · AlarmEntryAdded = `.2.3` · AlarmEntryRemoved = `.2.4`
⚠️ Un agent SNMPv1 historique converti vers v2 insère un `.0` : `1.3.6.1.2.1.33.2.0.N`. Tester les deux formes.

---

## 2. APC PowerNet — `1.3.6.1.4.1.318.1.1.1` — repli quand la RFC 1628 manque
Tous scalaires, suffixe `.0` à l'usage.

| nom | OID | unité |
|---|---|---|
| upsBasicIdentModel | .1.1.1 | — |
| upsAdvIdentFirmwareRevision | .1.2.1 | — |
| upsBasicBatteryStatus | .2.1.1 | énum |
| upsAdvBatteryCapacity | .2.2.1 | **% direct** |
| upsAdvBatteryTemperature | .2.2.2 | °C — **255 = non supporté** |
| upsAdvBatteryRunTimeRemaining | .2.2.3 | **TimeTicks (centièmes de s !)** — **4294967295 = non supporté** |
| upsHighPrecBatteryCapacity | .2.3.1 | dixièmes de % |
| upsAdvInputLineVoltage | .3.2.1 | V entiers |
| upsBasicOutputStatus | .4.1.1 | énum 28 valeurs |
| upsAdvOutputLoad | .4.2.3 | % |
| upsHighPrecOutputLoad | .4.3.3 | dixièmes de % |

`upsBasicBatteryStatus` : `unknown(1)`, `batteryNormal(2)`, `batteryLow(3)`, `batteryInFaultCondition(4)`, `noBatteryPresent(5)`

`upsBasicOutputStatus` (28 valeurs, bien plus riche que RFC 1628) : unknown(1), onLine(2), onBattery(3),
onSmartBoost(4), timedSleeping(5), softwareBypass(6), off(7), rebooting(8), switchedBypass(9),
hardwareFailureBypass(10), sleepingUntilPowerReturn(11), onSmartTrim(12), ecoMode(13), hotStandby(14),
onBatteryTest(15), emergencyStaticBypass(16), staticBypassStandby(17), powerSavingMode(18), spotMode(19),
eConversion(20), chargerSpotmode(21), inverterSpotmode(22), activeLoad(23), batteryDischargeSpotmode(24),
inverterStandby(25), chargerOnly(26), distributedEnergyReserve(27), selfTest(28)

⇒ **à replier sur le vocabulaire commun de `ups_status`**, sinon la capability a 28 valeurs chez APC et 7 ailleurs.

---

## 3. POWER-ETHERNET-MIB (RFC 3621) — `1.3.6.1.2.1.105` — driver PoE, plus tard

`pethPsePortTable` = `1.3.6.1.2.1.105.1.1.1`, index `{groupe, port}` :
`pethPsePortAdminEnable` = `.1.1.1.3.g.p` (TruthValue, **RW** ⇒ couper/rallumer le PoE) ·
`pethPsePortDetectionStatus` = `.1.1.1.6.g.p` · `pethPsePortPowerPriority` = `.1.1.1.7.g.p` (RW) ·
compteurs Overload `.13`, Short `.14`, PowerDenied `.12`

`pethPsePortDetectionStatus` : `disabled(1)`, `searching(2)`, `deliveringPower(3)`, `fault(4)`, `test(5)`, `otherFault(6)`

⚠️ **`pethMainPseTable` = `1.3.6.1.2.1.105.1.3.1`** — le chemin passe par `pethObjects.3.1`, **pas**
`powerEthernetMIB.3`. Beaucoup de résumés générés se trompent là-dessus.
`pethMainPsePower` = `.1.3.1.1.2.g` (W) · `pethMainPseOperStatus` = `.1.3.1.1.3.g` ·
`pethMainPseConsumptionPower` = `.1.3.1.1.4.g` (W) · `pethMainPseUsageThreshold` = `.1.3.1.1.5.g` (%, RW)

Traps `1.3.6.1.2.1.105.0` : PortOnOff `.0.1`, MainPowerUsageOn `.0.2`, MainPowerUsageOff `.0.3`

---

## 4. IF-MIB (RFC 2863) — driver switch, plus tard

`ifNumber` = `1.3.6.1.2.1.2.1.0` · `ifDescr` = `.2.2.1.2.n` · `ifType` = `.2.2.1.3.n` ·
`ifSpeed` = `.2.2.1.5.n` · **`ifAdminStatus` = `.2.2.1.7.n` (RW ⇒ couper un port)** ·
`ifOperStatus` = `.2.2.1.8.n` · `ifInErrors` = `.2.2.1.14.n` · `ifOutErrors` = `.2.2.1.20.n`

`ifXTable` (`1.3.6.1.2.1.31.1.1`) : `ifName` `.1.1.n` · **`ifHCInOctets` `.1.6.n` / `ifHCOutOctets` `.1.10.n`
(Counter64, exigent SNMPv2c)** · `ifHighSpeed` `.1.15.n` (Mbit/s) · `ifAlias` `.1.18.n` (RW) ·
`ifCounterDiscontinuityTime` `.1.19.n`

`ifOperStatus` : up(1), down(2), testing(3), unknown(4), dormant(5), notPresent(6), lowerLayerDown(7)

⚠️ `ifSpeed` plafonne à 4 294 967 295 bit/s (~4,29 Gbit/s) — au-delà, lire `ifHighSpeed`.

---

## 5. PDU — aucune RFC, un dialecte par constructeur

**Eaton ePDU** — `1.3.6.1.4.1.534.6.6.7.6.6.1`, index `{unit, outlet}` — *confirmé deux fois* :
`outletControlStatus` `.2.u.i` (R) · `outletControlOffCmd` `.3.u.i` · `outletControlOnCmd` `.4.u.i` ·
`outletControlRebootCmd` `.5.u.i` — **tous RW**
`outletControlStatus` : `off(0)`, `on(1)`, `pendingOff(2)`, `pendingOn(3)`
⚠️ Eaton n'utilise **pas** une énumération de commande : on écrit un **délai en secondes** (0 = immédiat,
-1 = annule) dans trois objets distincts. Unique parmi les quatre constructeurs.

**Raritan PDU2** — `1.3.6.1.4.1.13742.6.4.1.2.1`, index `{pdu, outlet}` :
`switchingOperation` `.2.p.o` (**RW** : `off(0)`, `on(1)`, `cycle(2)`) · `outletSwitchingState` `.3.p.o` (R)
⚠️ Les vrais noms n'ont **pas** de préfixe `pdu2`. Et l'état lu vaut `on(7)`/`off(8)`, **pas** la même
échelle que la commande écrite (0/1/2).

**CyberPower ePDU2** — `1.3.6.1.4.1.3808.1.1.6.6.1` :
`ePDU2OutletSwitchedStatusState` `.4.1.5.i` (`on(1)`, `off(2)`) ·
`ePDU2OutletSwitchedControlCommand` `.5.1.5.i` (**RW**) : immediateOn(1), immediateOff(2),
immediateReboot(3), delayedOn(4), delayedOff(5), delayedReboot(6), cancelPendingCommand(7), outletIdentify(8)

**APC rPDU** — `1.3.6.1.4.1.318.1.1.4.4.2` ⚠️ **non vérifié ligne à ligne** ; même famille d'énumération
que CyberPower. À confirmer avant implémentation.

---

## Pièges — à traiter explicitement dans le code

1. **Unités en dixièmes** : `upsBatteryVoltage` (0,1 V), `upsInputFrequency` / `upsOutputFrequency` (0,1 Hz),
   `upsInputCurrent` / `upsOutputCurrent` (0,1 A). Mais `upsInputVoltage` / `upsOutputVoltage` sont en
   **volts entiers**. Se tromper donne un facteur 10 crédible et donc invisible.
2. **Trois unités pour « temps restant »** : RFC 1628 = minutes · APC = TimeTicks (centièmes de s) ·
   CyberPower = TimeTicks. Normaliser en minutes dès le lecteur.
3. **Index de table = 1, pas 0.** Un onduleur monophasé n'a qu'une ligne, mais l'OID est `...1.5.1`,
   jamais `...1.5.0`. Piège classique quand on copie un scalaire par réflexe.
4. **APC signale l'absence par une sentinelle, pas par noSuchObject** : `255` (température),
   `4294967295` (TimeTicks). Sans traitement, on affiche « 4294967295 minutes restantes ».
5. **`upsAlarmDescr` peut pointer hors des 24 alarmes RFC** : APC et Eaton définissent les leurs sous leur
   MIB privée. Un décodeur qui ne connaît que la RFC doit dégrader proprement, pas planter.
6. **Le groupe `upsBypass` (`.1.5`) est optionnel** : la plupart des onduleurs domestiques renvoient
   noSuchObject sur tout le sous-arbre.
7. **`ifHCInOctets` / `ifHCOutOctets` sont Counter64 ⇒ SNMPv2c obligatoire.** `SnmpVersion` de
   `snmp-client.mts` autorise déjà v1 — un switch interrogé en v1 perdra silencieusement ces compteurs.
8. **Compteurs 32 bits qui débordent** : `ifInErrors`, `ifOutErrors`, `upsInputLineBads`. Pas d'équivalent
   64 bits — gérer le wraparound, ou n'exposer que la valeur brute sans calcul de delta.
9. **Traps RFC 1628** : `1.3.6.1.2.1.33.2.N` en v2c natif, `1.3.6.1.2.1.33.2.0.N` si converti depuis v1.

⚠️ Restent non vérifiés : table `rPDUOutletControlTable` APC, OID legacy CyberPower
`upsIndividualOutletControlCommand`, et la référence RFC exacte de la règle de conversion trap v1→v2.

---

## 6. Onduleur relayé par un NAS — **le chemin principal du driver v1**

### 6a. Synology — `SYNOLOGY-UPS-MIB`, base `1.3.6.1.4.1.6574.4`

**Verdict : faisable, sans rien installer.** L'utilisateur active SNMP dans DSM
(Panneau de configuration → Terminal & SNMP) et a déjà configuré son onduleur USB
(Matériel & Alimentation → UPS). Le démon interne de DSM est basé sur NUT, mais c'est géré par
Synology : l'utilisateur n'installe ni ne configure NUT. Recoupé deux fois — MIB officielle vs
article Paessler vs script de production `kernelkaribou/synology-monitoring`.

| nom | OID | type | unité |
|---|---|---|---|
| upsDeviceModel | .4.1.1.0 | DisplayString | — |
| upsDeviceManufacturer | .4.1.2.0 | DisplayString | — |
| upsDeviceSerial | .4.1.3.0 | DisplayString | — |
| **upsInfoStatus** | **.4.2.1.0** | **DisplayString** (chaîne NUT, pas un enum) | — |
| upsInfoAlarm | .4.2.2.0 | DisplayString | — |
| upsInfoTemperature | .4.2.11.0 | **Float/Opaque** | °C |
| upsInfoLoadValue | .4.2.12.1.0 | **Float/Opaque** | % |
| **upsBatteryChargeValue** | **.4.3.1.1.0** | **Float/Opaque** | % |
| upsBatteryChargeLow | .4.3.1.2.0 | Float/Opaque | % (seuil LB) |
| upsBatteryVoltageValue | .4.3.2.1.0 | Float/Opaque | V DC |
| upsBatteryVoltageNominal | .4.3.2.2.0 | Float/Opaque | V DC |
| upsBatteryCapacity | .4.3.3.0 | Float/Opaque | Ah |
| upsBatteryCurrent | .4.3.4.0 | Float/Opaque | A DC |
| upsBatteryTemperature | .4.3.5.0 | Float/Opaque | °C |
| **upsBatteryRuntimeValue** | **.4.3.6.1.0** | **Integer32** (pas Float) | **secondes** |
| upsBatteryRuntimeLow | .4.3.6.2.0 | Integer32 | secondes (seuil LB) |

#### 🔴 Piège n°1 — `Opaque Float`, à décoder à la main

Presque toutes les mesures Synology sont en `SYNTAX Float` importé de `NET-SNMP-TC`, encodé sur le fil
en **ASN.1 `Opaque`** avec l'extension propriétaire Net-SNMP — **pas** en entier standard.

Vérifié dans `node_modules/net-snmp` : la lib traite `Opaque` comme une chaîne d'octets et **ne décode
pas** le flottant (`readString(ObjectType.Opaque, true)`). Bonne nouvelle : `toValue()` de
`snmp-client.mts` renvoie déjà un `Buffer` intact pour ce cas — les octets arrivent donc entiers.

Disposition confirmée (Net-SNMP `ASN_OPAQUE_FLOAT_BER_LEN = 7`) :

```
9f 78 04 <4 octets IEEE754 big-endian>      // float   — ex. 123 → 9f78 04 42f60000
9f 79 08 <8 octets IEEE754 big-endian>      // double  — rare
```

```ts
/** Décode le flottant Opaque propriétaire de Net-SNMP. Renvoie null si ce n'en est pas un. */
function decodeOpaqueFloat(buf: Buffer): number | null {
  if (buf.length === 7 && buf[0] === 0x9f && buf[1] === 0x78 && buf[2] === 0x04) {
    return buf.readFloatBE(3);
  }
  if (buf.length === 11 && buf[0] === 0x9f && buf[1] === 0x79 && buf[2] === 0x08) {
    return buf.readDoubleBE(3);
  }
  return null;
}
```

#### 🔴 Piège n°2 — `upsInfoStatus` est une chaîne NUT, pas un code

Synology réexpose littéralement le champ `ups.status` de NUT. Les flags se **combinent**, séparés par
une espace (`"OL CHRG"`, `"OB LB"`). Il faut donc parser des jetons, pas comparer une valeur.

| flag | sens | | flag | sens |
|---|---|---|---|---|
| `OL` | sur secteur | | `RB` | batterie à remplacer |
| `OB` | **sur batterie** | | `BYPASS` | bypass, plus de protection |
| `LB` | batterie faible | | `CAL` | calibration en cours |
| `HB` | batterie haute | | `OFF` | onduleur éteint |
| `CHRG` | en charge | | `OVER` | surcharge |
| `DISCHRG` | en décharge | | `TRIM` / `BOOST` | correction de tension |
| | | | `FSD` | arrêt forcé |

En production sur Synology, seules trois combinaisons ont été observées : `OL`, `OL CHRG`,
`OL DISCHRG` — mais rien n'interdit `OB LB` selon le modèle d'onduleur et l'état réel.

### 6b. QNAP — `1.3.6.1.4.1.55062.1.13` — **à traiter comme incertain**

⚠️ Deux PEN QNAP coexistent au registre IANA : `24681` (l'ancienne, largement citée — **aucun objet
UPS**) et `55062` (la branche QTS moderne, **c'est elle qui porte l'UPS**).

`upsStatus` `.13.1.0` · `upsModel` `.13.2.0` · `upsDeviceManufacturer` `.13.3.0` ·
`upsDeviceSerial` `.13.4.0` · `upsLoadPercentage` `.13.6.0` · `upsBatteryCharge` `.13.7.0` ·
`upsBatteryChargeWarningLevel` `.13.8.0` · `upsBatteryType` `.13.9.0`
Également `sysUPSStatus` = `1.3.6.1.4.1.55062.1.12.20.0` (INTEGER, ⚠️ énumération non publiée).

**Tout est en `DisplayString`**, et il n'y a **ni autonomie, ni tension, ni température**. Aucune
confirmation de terrain trouvée — seule la définition MIB est vérifiée, pas le comportement réel.
⇒ **Ne pas fonder le plan dessus.** À tester sur un vrai NAS avant de s'y engager.

### 6c. Linux générique + NUT + snmpd — **non**

NUT n'implémente aucun agent SNMP (protocole propre, port 3493). Un `snmpd` Net-SNMP standard
n'exposera **aucun OID UPS-MIB**. Il faut un pont tiers explicite (`luizluca/nut-snmpagent`, via
`pass_persist`). ⇒ Hors périmètre : ce n'est pas « cocher une case » comme chez Synology.

### 6d. Quatre unités pour « temps restant »

| source | objet | unité |
|---|---|---|
| RFC 1628 | `upsEstimatedMinutesRemaining` | **minutes** |
| APC PowerNet | `upsAdvBatteryRunTimeRemaining` | **centièmes de seconde** (TimeTicks) |
| CyberPower | `upsAdvanceBatteryRunTimeRemaining` | centièmes de seconde |
| **Synology** | `upsBatteryRuntimeValue` | **secondes** |

À normaliser en minutes dès le lecteur, jamais plus haut.
