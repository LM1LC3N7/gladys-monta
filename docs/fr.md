# Monta

Affiche les bornes de votre compte **Monta** dans Gladys, par
l'[API publique officielle de Monta](https://docs.public-api.monta.com) : état
de la borne, véhicule branché, état et énergie de la charge, batterie du
véhicule (quand il la transmet) et relevé du compteur. Un bouton arrête la
charge ; un autre la démarre, seulement si vous l'autorisez.

> Jamais testé avec une vraie borne : écrit d'après la documentation publique
> de l'API et monta-python, et testé seulement contre des réponses
> fabriquées. Sans lien avec Monta.

## Avant de commencer

1. Connectez-vous au portail Monta (<https://portal2.monta.app>).
2. Ouvrez le menu utilisateur (en bas à gauche), puis **Applications**, puis
   **+ Add Application**. Donnez-lui les portées :
   - `charge-points` (les bornes ; obligatoire),
   - `charge-transactions` (les charges : énergie, batterie, état ;
     recommandé),
   - `control-charging` (seulement pour les boutons de démarrage et d'arrêt).
3. Copiez l'**identifiant client** et le **secret client**. Monta n'affiche
   le secret qu'une fois : s'il est perdu, utilisez **Reset** dans la liste
   des applications.

## Configuration

| Champ                               | Rôle                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Identifiant client                  | L'identifiant client de l'application.                                                                              |
| Secret client                       | Gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement à Monta, en HTTPS, pour obtenir un jeton d'accès. |
| Autoriser le démarrage d'une charge | Désactivé par défaut. Voir « Commandes ».                                                                           |
| Intervalle de rafraîchissement      | 120 s par défaut, de 60 s à 1 h.                                                                                    |
| Langue                              | Des noms des fonctionnalités, des textes d'état et des erreurs des commandes.                                       |

Enregistrez, puis ajoutez les bornes depuis l'onglet **Découverte**.

## Ce que vous obtenez

Un appareil par borne (son identifiant Monta est l'identifiant de l'appareil,
pour toujours) :

| Fonctionnalité       | Valeur                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| État                 | L'état de la borne (disponible, en charge, véhicule branché sans charge, erreur, déconnectée de Monta...). |
| Connecteur           | Disponible, occupé, réservé, indisponible, en défaut.                                                      |
| État de charge       | En charge, véhicule connecté, en pause, inactif.                                                           |
| Véhicule branché     | 0 / 1.                                                                                                     |
| Charge               | L'état de la charge en cours, ou de la dernière.                                                           |
| Énergie de la charge | kWh de la charge en cours, ou de la dernière.                                                              |
| Batterie du véhicule | %, quand le véhicule la transmet.                                                                          |
| Relevé du compteur   | Le dernier relevé du compteur de la borne, en kWh : un capteur simple, jamais compté par l'onglet énergie. |
| Démarrer une charge  | Bouton.                                                                                                    |
| Arrêter la charge    | Bouton.                                                                                                    |

L'API publique ne donne **aucune puissance instantanée** : il n'y a pas de
fonctionnalité de puissance. Le relevé du compteur n'est pas un index
d'énergie : la borne est derrière votre compteur principal, la compter la
compterait deux fois. L'emplacement de la borne n'est jamais lu dans Gladys.

## Commandes

- **Arrêter la charge** est toujours disponible : sans option, jamais bloqué
  par une pause demandée par Monta. Il lit d'abord les charges de la borne
  quand il le peut, sinon il arrête la charge en cours connue à la dernière
  lecture (gardée dans `/data`, donc possible juste après un redémarrage).
  Pendant 90 s après un arrêt, une charge qui reprend est arrêtée à nouveau
  (deux fois au plus) ; une charge démarrée plus tard par quelqu'un depuis
  l'application Monta n'est pas touchée.
- **Démarrer une charge** refuse tant que « Autoriser le démarrage d'une
  charge » est désactivé. Il lit la borne et ses charges juste avant l'envoi,
  et n'envoie que si un véhicule est branché, que la borne est prête et
  qu'aucune charge n'est en cours. L'option est revérifiée juste avant
  l'envoi ; un arrêt cliqué entre-temps l'annule. Gladys reçoit sa réponse
  sous 5 s : un démarrage sans réponse d'ici là est signalé « envoyée, sans
  confirmation » et l'état suit.
- Les deux sont des boutons, jamais des interrupteurs : un « tout éteindre »
  ne peut jamais les atteindre.

## Limites et erreurs

- Monta autorise **10 requêtes par minute** pour toutes les applications de
  votre compte. Une lecture prend deux requêtes (trois quand le jeton est
  renouvelé) et ne démarre que si quatre restent libres pour les commandes.
- Identifiant ou secret client refusé : l'intégration s'arrête pour de bon
  (aucun nouvel essai automatique, qui pourrait bloquer l'application).
  Enregistrez des identifiants corrigés, ou cliquez sur **Tester la
  connexion** une fois le problème réglé côté Monta.
- Un 403 sur les bornes (portée `charge-points` absente) arrête de la même
  façon. Un 403 sur les charges laisse seulement les fonctionnalités de la
  charge en l'état ; un 403 sur une commande refuse seulement cette commande.
- Un 429 (trop de requêtes) ou une panne de Monta met les lectures en pause
  (gardée après un redémarrage) ; arrêter une charge reste possible.
- L'intégration ne relit jamais Monta avant l'intervalle : ni au
  redémarrage, ni à une reconnexion, ni à l'enregistrement d'une
  configuration inchangée, ni au bouton de test. Seuls de nouveaux
  identifiants enregistrés sont essayés tout de suite.

## Confidentialité

Rien de secret n'est écrit dans `/data` : seulement l'heure de la dernière
lecture, les pauses, les identifiants des bornes et de leur charge en cours,
et, après des identifiants refusés, une empreinte salée de ces identifiants
refusés (effacée au premier succès). Les jetons restent en mémoire et
n'atteignent jamais les journaux.

Sans lien avec Monta. Monta est une marque de son propriétaire.
