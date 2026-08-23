SNMP - Network Devices brings your UPS, your NAS and your switch ports into Homey.

The point of a UPS is that Homey should act on a power cut, not merely survive it.
This app reads the UPS over the network and turns the moment mains power is lost
into a Flow trigger, while the battery still holds — so the non-essentials can go
off and the NAS can be shut down cleanly before the runtime is spent.

There is nothing to install on the equipment. Everything is read over SNMP, which
UPS network cards, NAS boxes and managed switches already speak.

A UPS PLUGGED INTO YOUR NAS

Most home UPS units have no network card. They sit on a USB cable behind a NAS,
which is exactly where the existing Homey apps stop. This app reads that UPS
through the NAS itself: on a Synology, enable SNMP in DSM and configure the UPS in
Hardware & Power, and it appears. You install nothing and configure no daemon.

An honest limitation comes with it. The NAS is powered by the UPS it reports on,
so DSM shuts it down partway through a long outage. The app sees the beginning of
a cut reliably, and loses contact before the end of a long one. It says so rather
than pretending the power came back: losing contact while the last known state was
"on battery" is its own Flow trigger. A UPS with its own network card does not
have this limitation.

WHAT YOU GET

- A UPS: charge, runtime in minutes, output load, voltages and temperature.
- Alarms for mains lost, low battery, overload and a battery needing replacement.
- An alarm text that names what is wrong, in the UPS's own words. Four booleans can
  say something is wrong; only this says which thing.
- A NAS or server: CPU load, memory, storage per volume, and uptime.
- Switch ports, one Homey device per port: link, negotiated speed, errors and PoE
  power draw.

CONTROL, OFF BY DEFAULT

Switch ports can be switched off and PoE can be cycled — a stuck camera comes back
without walking to the rack. This is disabled until you enable it per device, and
the setting says plainly why: the port you cut may be the one feeding your access
point, your router or Homey itself, and getting it back then needs physical access.

FINDING YOUR EQUIPMENT

The app sweeps your network and offers what answers, so there is no address to look
up and no OID to know. When nothing is found it tells you what to switch on rather
than reporting an empty list — SNMP is off by default on recent APC network cards,
and disabled until enabled on a Synology.

WHAT IS NOT SUPPORTED

- QNAP UPS relaying: the OIDs exist but are unconfirmed on real hardware.
- A Linux host running NUT: NUT has no SNMP agent, so a plain snmpd exposes nothing.
- SNMPv3: v1 and v2c only for now.
