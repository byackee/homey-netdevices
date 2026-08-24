Een UPS dient ervoor dat Homey handelt bij een stroomstoring, niet dat hij die alleen
overleeft. Deze app leest uw UPS via het netwerk en maakt van het wegvallen van de
netspanning een Flow-trigger, terwijl de accu het nog houdt — zodat het niet-essentiële
uit kan en de NAS netjes wordt afgesloten voordat de looptijd op is. NAS-en en poorten van
een managed switch leest hij op dezelfde manier. Er hoeft niets op de apparatuur te worden
geïnstalleerd: alles gaat via SNMP, dat ze al spreken.

De meeste UPS-en voor thuis hebben geen netwerkkaart en hangen aan een USB-kabel achter
een NAS — precies waar de bestaande apps ophouden. Deze leest die UPS via de NAS zelf. Er
hoort één eerlijke beperking bij: de NAS wordt gevoed door de UPS waarover hij rapporteert
en valt dus halverwege een lange storing uit. Het contact verliezen terwijl de laatst
bekende toestand "op accu" was, is een eigen Flow-trigger — geen stilte die zou doen
geloven dat de stroom terug is.
