# Network Devices

A Homey app that reads network equipment over SNMP. Version 1 covers one class of
device: the **UPS** — including, and above all, a USB UPS plugged into a Synology NAS.

Homey app id: `com.dataweavelabs.netdevices`.

## Why this exists

On the Homey forum, *"Anyone using the APC app successfully?"* has been open since
September 2018 and is still failing today. The symptom never changes: **"No new devices
found"**. The existing APC app needs an `apcupsd` daemon on a separate Linux machine, or
a network management card in the UPS. The NUT app needs a NUT server. Neither finds
anything on its own.

The request nobody has answered is the simple one: *my UPS is plugged into my Synology.*

That is the path this app takes first. A network card for a UPS costs around €200 and is
rare in a home; a NAS relaying a USB UPS is not. Synology publishes the UPS over SNMP
under `SYNOLOGY-UPS-MIB`, and DSM runs NUT for you — **you do not install or configure
NUT yourself.**

## What you have to enable

This is where the competing apps die, so it is the first thing in the settings page too.

**Synology** — two checkboxes:

1. Control Panel → Terminal & SNMP → enable SNMP, SNMPv1/v2c.
2. Hardware & Power → UPS → set the USB UPS up.

**A UPS with its own network card** — on recent APC NMC firmware **SNMP is off by
default**, both v1 and v3. In the card's web interface: Configuration → Network → SNMPv1
→ enable it, and leave the community as `public`. Until you do, a subnet sweep cannot see
it at all.

**How to tell the two failures apart.** "Nothing found" and "found but switched off" look
identical from the outside and need opposite fixes, so the app never conflates them. When
an address answers a ping but stays silent over SNMP, both the pairing view and the app
settings page say exactly that — *reachable, no SNMP answer* — instead of reporting an
empty list. That one distinction is the difference between a five-minute fix and the
eight-year-old forum thread this app exists to close.

## What is *not* supported, plainly

- **A plain Linux box running NUT is not supported.** NUT has no SNMP agent, and exposes
  nothing over SNMP without a third-party bridge such as `nut-snmpagent`.
- **SNMPv3 is not implemented.** Only v1 and v2c. DSM offers v1/v2c as a checkbox separate
  from v3, and an APC card accepts v1/v2c once SNMP is on, so this is not a blocker for
  most people — but if you run v3 exclusively, this app cannot talk to your UPS yet. It
  is on the roadmap; `net-snmp` supports v3 natively and the change is confined to the
  client.
- **QNAP is not confirmed.** There is an OID base for it and nothing has been tested
  against a real NAS. Nothing is promised.
- **Writing is not supported, deliberately.** RFC 1628 exposes shutdown, reboot and
  battery-calibration commands. A badly scoped Flow could cut power to everything on the
  UPS — possibly the Homey itself, the router and the NAS — and a deep battery
  calibration wears the battery out. Version 1 is read-only, without exception.

## The honest limitation of the NAS path

The app exists to react to power cuts. On the Synology path, the sensor sits on the very
machine it is watching: the NAS is powered by the UPS, and DSM shuts it down after the
delay you configured. **The data source disappears during the event it is there to
detect.**

| t | what happens | what the app sees |
|---|---|---|
| 0 s | mains fails | — |
| ~10 s | next fast poll | ✅ on battery — the trigger fires |
| 0–N min | runtime counting down | ✅ tracked |
| N min | DSM shuts the NAS down | ❌ nothing |
| N+30 s | polls failing | ⚠️ contact lost during an outage |
| mains returns | the NAS boots | ⏳ seen late, at boot |

**What works:** the trigger that matters — shut the non-essential things down — fires
within ten seconds. That is most of the value, and it is intact.

**What does not:** the *end* of the outage. Losing contact while the last known state was
"on battery" is treated as information rather than as a plain unreachable device: it
raises its own trigger and the state stays pinned to "on battery", because the app does
not get to claim the power is back when it cannot see.

A UPS with its own network card does not have this limitation — the card is powered by
the UPS and lives as long as it does. That is the honest argument for buying one if you
want to see an outage from beginning to end.

## What you can actually build with it

The point of the app is not a battery percentage on a dashboard. It is this Flow, which
nothing else on Homey lets you write today:

> **When** the UPS switches to battery → turn the media centre, the desk lamps and the
> second NAS off.
> **And when** runtime drops below 5 minutes → shut the main NAS down properly, before the
> UPS drops it mid-write.

The first card buys you runtime by shedding load within about ten seconds of the cut. The
second one spends the runtime you bought on the one thing that must not be cut abruptly.
Twelve cards ship, and they exist to make that pair of rules — and its variants —
expressible.

### Triggers

| Card | Fires when | Why it is separate |
|---|---|---|
| **The UPS switches to battery** | Mains fails | The load-shedding card. Carries runtime, battery and load as tokens. |
| **Mains power comes back** | The UPS says it is back on mains | Only the UPS's own word counts, never a guess from the app having regained contact. |
| **Contact is lost while on battery** | Polling fails during an outage | The NAS relaying the UPS is powered *by* it and switches off partway through. This says "the outage is still going and I have gone blind", which is not the same as a device being offline. |
| **The battery becomes low** | The UPS raises its own low-battery flag | Uses the threshold configured on the UPS, not a percentage invented here. |
| **Runtime drops below** | Runtime crosses your threshold | Fires **on the crossing, once per outage** — not on every reading below it. Each Flow gets its own number of minutes. |
| **The UPS is overloaded** | Too much is plugged in | Fires once when the alarm appears. |
| **The battery needs replacing** | The UPS raises the flag | A worn battery stays flagged for weeks, so this must not repeat on every poll. |
| **The status changes** | The status enters a state you pick | The catch-all, for states the specific cards do not cover. |

### Conditions

| Card | Notes |
|---|---|
| **The UPS is / is not on battery** | The plain guard for any Flow that should not run during an outage. |
| **Runtime is / is not above *n* minutes** | **False when the runtime is unknown.** An unread value is not a comfortable margin. |
| **Battery is / is not above *n* %** | False when the charge is unknown, for the same reason. |

### Action

| Card | Notes |
|---|---|
| **Read the UPS now** | Reads the fast group outside the schedule. It is the only action card, and it only reads — see the read-only decision above. |

## Diagnostics

An app installed with `homey app install` has no readable log: Developer Tools lists App
Store submissions only, and the CLI has no log command. So the app keeps a bounded,
timestamped ring buffer of what it did, served by `GET /trace` and shown at the bottom of
the app settings page. Attach it to any bug report.

## Development

```sh
npm install
npm run typecheck        # tsc --noEmit, app and tests
npm test                 # node --test over the compiled tests
npm run validate         # homey app validate --level debug
npm run app:run          # run against a Homey on the same network
```

`app.json` at the repository root is generated by HomeyCompose from
`.homeycompose/app.json`, but it is committed anyway: the CLI reads it *before* it
generates it, so it has to exist to bootstrap.

## Adding a device

Add device → *Network Devices* → UPS. Homey sweeps your subnet for anything that
answers over SNMP and lists what it found; pick your UPS and it is added. A full sweep of
a /24 takes about fifteen seconds, so the view shows progress rather than freezing.

Devices are matched on their **SNMP identity** — model and serial — never on their IP
address, so a UPS that moves is still recognised as the same device. If it does move, the
device's *Repair* flow points it at the new address without losing its history. Reserving
a fixed address in your router is still the right fix.

If the list comes back empty, the view tells you what to switch on rather than saying "no
devices found" — see *What you have to enable* above.

## Status

Feature-complete and submitted, not yet published. Version 1.0.10 went to certification
and was rejected on three counts — the protocol name in the app name, the NAS and switch
driver images, and a settings-page bug that made every connection test report a failure.
All three are fixed in 1.0.11, which is what goes back for review.

## Naming note

The Homey App Store guidelines forbid protocol names in an app's display name and cap it
at four words, and version 1.0.10 was rejected on exactly that: *"Your app's name contains
the protocol name SNMP"*. The display name is now **Network Devices**. The app id never
carried the protocol, which is why it could stay `com.dataweavelabs.netdevices` across the
rename — a Homey app id cannot change without becoming a different app.

`SNMP` stays in the description and in the store tags, where it is allowed and where it is
what people search for. `test/store-review.test.mts` keeps the name clear of protocol
names from now on.

## Support ❤️

This app is free, and built on my own time — evenings spent reading MIBs so that a UPS
plugged into a NAS, or a switch port nobody was watching, finally shows up in Homey. If
it saves your server from an unnoticed power cut, you can support the work:

- ☕ Buy me a coffee: https://buymeacoffee.com/byackee
- 🔗 All my links: https://linktr.ee/byackee

Opening an issue with what your own hardware reports helps just as much — every device
that lands here makes the next one work out of the box. Thank you for using it, and for
every bit of support 🙏

## Licence

See `LICENSE`.
