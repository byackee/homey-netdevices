Un onduleur sert à ce que Homey agisse sur une coupure de courant, pas seulement à ce
qu'il y survive. Cette app lit votre onduleur par le réseau et fait de la perte du secteur
un déclencheur de Flow, pendant que la batterie tient encore — de quoi éteindre le non
essentiel et arrêter proprement le NAS avant la fin de l'autonomie. Elle lit de la même
façon les NAS et les ports d'un switch administrable. Rien à installer sur le matériel :
tout passe par SNMP, qu'il parle déjà.

La plupart des onduleurs domestiques n'ont pas de carte réseau et vivent au bout d'un
câble USB derrière un NAS — précisément là où les apps existantes s'arrêtent. Celle-ci lit
cet onduleur à travers le NAS lui-même. Une limite honnête l'accompagne : le NAS est
alimenté par l'onduleur qu'il rapporte, il s'éteint donc au milieu d'une longue coupure.
Perdre le contact alors que le dernier état connu était « sur batterie » est un
déclencheur de Flow à part entière, plutôt qu'un silence qui laisserait croire au retour
du courant.
