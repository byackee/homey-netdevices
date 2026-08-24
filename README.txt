The point of a UPS is that Homey should act on a power cut, not merely survive it. This
app reads your UPS over the network and turns the moment mains power is lost into a Flow
trigger, while the battery still holds — so the non-essentials can go off and the NAS can
be shut down cleanly before the runtime is spent. It reads NAS boxes and managed switch
ports the same way. There is nothing to install on the equipment: everything goes over
SNMP, which they already speak.

Most home UPS units have no network card and sit on a USB cable behind a NAS, which is
exactly where the existing apps stop. This one reads that UPS through the NAS itself. One
honest limitation comes with it: the NAS is powered by the UPS it reports on, so it shuts
down partway through a long outage. Losing contact while the last known state was "on
battery" is its own Flow trigger, rather than a silent pretence that the power came back.
