# Picnic pour Gladys Assistant

Affiche vos livraisons de courses **Picnic** dans Gladys (Pays-Bas,
Allemagne, Belgique, France), en lecture seule : le créneau de la prochaine
livraison, son heure d'arrivée estimée quand Picnic la donne, la date limite
de commande, l'état de la dernière commande et le panier. Un déclencheur de
scène part quand la livraison approche.

> **API non officielle, jamais testée avec un vrai compte.** L'intégration
> parle à l'API de l'application Picnic, que Picnic ne documente pas et peut
> changer à tout moment. Elle a été écrite à partir de python-picnic-api2 et
> de l'intégration Home Assistant, et testée seulement avec des réponses
> inventées. Sans lien avec Picnic.

## Ce que vous obtenez

Un appareil, **Picnic**, avec ces fonctionnalités (toutes en lecture seule) :

| Fonctionnalité                         | Exemple                          | Remarques                                                                |
| -------------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| Prochaine livraison : début du créneau | `2026-10-18 14:15`               | heure locale donnée par Picnic ; `—` sans livraison prévue               |
| Prochaine livraison : fin du créneau   | `2026-10-18 16:15`               |                                                                          |
| Prochaine livraison : arrivée estimée  | `2026-10-18 14:48 (14:40–15:00)` | seulement quand Picnic donne une heure (souvent le jour même), sinon `—` |
| Commander avant                        | `2026-10-17 23:00`               | voir ci-dessous                                                          |
| État de la dernière commande           | `À venir`, `Livrée`, `Annulée`   | les autres états tels que Picnic les envoie                              |
| Panier : articles                      | `3`                              |                                                                          |
| Panier : total                         | `12.34` €                        |                                                                          |

**Commander avant** est la date limite de la livraison réservée tant qu'elle
peut encore être modifiée ; une fois passée, celle du créneau choisi dans le
panier, sinon du premier créneau proposé par le panier.

Gladys n'a pas de fonctionnalité de type date : les heures sont du texte,
affiché à l'heure locale envoyée par Picnic (le fuseau de votre pays Picnic).

Rien n'est jamais ajouté au panier ni commandé : cette version ne fait que
lire.

## Mise en place

1. Dans Gladys, installez l'intégration **Picnic** depuis le store.
2. Saisissez l'**e-mail** et le **mot de passe** de votre compte Picnic (ceux
   de l'application) et choisissez son **pays**, puis enregistrez.
3. Si l'état demande un code de vérification, voir ci-dessous.
4. Ouvrez l'onglet **Découverte** et ajoutez l'appareil **Picnic**.

Le champ du mot de passe est un champ `secret` : Gladys le garde dans sa base
(en clair, comme toute valeur de configuration, et dans ses sauvegardes), ne
le réaffiche jamais, et l'intégration ne l'envoie qu'à Picnic, sous la forme
MD5 qu'envoie l'application Picnic.

### Code de vérification (deux temps)

Pour une nouvelle connexion, Picnic peut demander un code envoyé par SMS ou
par e-mail. L'intégration n'en demande jamais d'elle-même (pas de SMS sans
votre clic). Quand l'état indique « Picnic demande un code de
vérification » :

1. Dans l'écran de configuration, sous **Envoyer le code de vérification**,
   choisissez **SMS** ou **E-mail** et cliquez sur le bouton. L'intégration
   se connecte et Picnic envoie le code.
2. Sous **Vérifier le code**, saisissez le code reçu et cliquez sur le
   bouton. « Code accepté » veut dire connecté.

La session est ensuite gardée (dans le `/data` de l'intégration) : pas de
code aux redémarrages suivants. Un code est demandé au plus une fois par
minute ; une connexion qui attend son code est relancée au bout de
10 minutes. Si le code est refusé, vérifiez-le ou demandez-en un nouveau.

## Rafraîchissement

- Toutes les **15 minutes** par défaut (5 à 60, _Intervalle de
  rafraîchissement_). Chaque lecture fait 2 requêtes : le panier et la liste
  des livraisons.
- **Jour de livraison** : dès 12 heures avant le créneau, toutes les
  5 minutes.
- **Autour de la livraison** : de 45 minutes avant le créneau (ou l'heure
  estimée) à 30 minutes après, toutes les 2 minutes, plus la position en
  direct (une troisième requête, pour l'heure d'arrivée).

## Déclencheur de scène « Livraison Picnic en approche »

Part **une fois par livraison**, quand l'arrivée estimée donnée par Picnic
est à au plus _Délai « livraison en approche »_ minutes (15 par défaut, 5 à
60). Sans heure estimée de Picnic, il ne part pas. Variables : `minutes`
(minutes avant l'arrivée), `eta`, `slot_start`, `slot_end` (heures locales
en texte). Exemple : allumer la lumière de l'entrée et envoyer le message
« Picnic dans 15 minutes ».

## En cas de problème

- **E-mail ou mot de passe refusé** : l'intégration s'arrête et attend.
  Vérifiez l'e-mail, le mot de passe et le pays, puis enregistrez (ou
  cliquez sur _Tester la connexion_). Elle ne se reconnecte jamais d'elle-même
  après un refus.
- **Session refusée** : le jeton de session gardé est refusé, l'intégration
  se reconnecte **une fois** ; refusée à nouveau, elle s'arrête avec un
  message. _Tester la connexion_ réessaie une fois.
- **Trop de requêtes (429)** : une pause de 1 minute à 6 heures (le
  `Retry-After` de Picnic, 15 minutes sans lui), pour toutes les lectures et
  tous les boutons.
- **Picnic indisponible (5xx, réseau)** : nouveaux essais après 2, 5, 10, 15,
  puis toutes les 30 minutes.
- Une panne de la position en direct ne cache jamais le panier et les
  livraisons.

## Limites

- API non officielle : Picnic peut la changer, la bloquer ou demander plus
  de vérifications.
- Lecture seule : pas de modification du panier, pas de commande (peut-être
  plus tard).
- Un seul compte Picnic par Gladys.
- Jamais testée avec un vrai compte : merci de signaler ce que vous voyez sur
  le [dépôt GitHub](https://github.com/LM1LC3N7/gladys-picnic/issues) (sans
  votre e-mail, mot de passe ni codes).

## Vie privée

L'intégration garde dans `/data/picnic-state.json` (lisible par son seul
conteneur) : un identifiant d'appareil aléatoire, le jeton de session, le
compte auquel il appartient sous forme d'empreinte de l'e-mail et du pays,
et les identifiants des livraisons déjà annoncées. Ni l'e-mail ni le mot de
passe. Rien n'est envoyé ailleurs qu'à Picnic.
