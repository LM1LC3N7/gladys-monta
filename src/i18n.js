// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, command errors, feature
// and state names), in English and French.
// -----------------------------------------------------------------------------

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

const both = (en, fr) => ({ en, fr });

/** What a text feature shows when there is nothing to show. */
export const NONE = both('No charge', 'Aucune charge');

/** Feature names, in the language chosen in the configuration. */
export const FEATURE_NAMES = {
  status: both('Status', 'État'),
  'connector-status': both('Connector', 'Connecteur'),
  'charging-state': both('Charging state', 'État de charge'),
  plugged: both('Vehicle plugged in', 'Véhicule branché'),
  'charge-status': both('Charge', 'Charge'),
  'session-energy': both('Energy of the charge', 'Énergie de la charge'),
  'vehicle-battery': both('Vehicle battery', 'Batterie du véhicule'),
  'meter-reading': both('Meter reading', 'Relevé du compteur'),
  'start-charge': both('Start a charge', 'Démarrer une charge'),
  'stop-charge': both('Stop the charge', 'Arrêter la charge'),
};

export const POINT_STATE_NAMES = {
  available: both('Available', 'Disponible'),
  busy: both('Busy', 'Occupée'),
  'busy-blocked': both('Busy (blocked)', 'Occupée (bloquée)'),
  'busy-charging': both('Charging', 'En charge'),
  'busy-non-charging': both('Vehicle plugged in, not charging', 'Véhicule branché, sans charge'),
  'busy-non-released': both('Cable not released', 'Câble non libéré'),
  'busy-reserved': both('Reserved', 'Réservée'),
  'busy-scheduled': both('Charge scheduled', 'Charge programmée'),
  error: both('Error', 'Erreur'),
  disconnected: both('Disconnected from Monta', 'Déconnectée de Monta'),
  passive: both('Passive (not controlled by Monta)', 'Passive (non pilotée par Monta)'),
  other: both('Other', 'Autre'),
  unknown: both('Unknown', 'Inconnu'),
};

export const CHARGE_STATE_NAMES = {
  reserved: both('Reserved', 'Réservée'),
  starting: both('Starting', 'Démarrage'),
  charging: both('Charging', 'En charge'),
  stopping: both('Stopping', 'Arrêt en cours'),
  paused: both('Paused', 'En pause'),
  scheduled: both('Scheduled', 'Programmée'),
  stopped: both('Stopped', 'Arrêtée'),
  completed: both('Completed', 'Terminée'),
};

/** "25 min" / "3 h", for the pauses. */
export function age(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

export const T = {
  noCredentials: both(
    'Enter the client id and the client secret of a Monta application (Monta portal, Applications).',
    "Saisissez l'identifiant client et le secret client d'une application Monta (portail Monta, Applications).",
  ),
  connecting: both('Connecting to Monta…', 'Connexion à Monta…'),
  waiting: (wait) =>
    both(
      `Waiting for the refresh interval: next read in ${wait.en}.`,
      `En attente de l'intervalle de rafraîchissement : prochaine lecture dans ${wait.fr}.`,
    ),
  connected: (count) =>
    both(
      `Connected to Monta: ${count} charge point(s). Open Discovery to add them.`,
      `Connecté à Monta : ${count} borne(s). Ouvrez Découverte pour les ajouter.`,
    ),
  chargesMissing: both(
    'The charges could not be read (the application needs the "charge-transactions" scope): the energy and the battery of the charge wait for the next read.',
    "Les charges n'ont pas pu être lues (l'application a besoin de la portée « charge-transactions ») : l'énergie et la batterie de la charge attendent la prochaine lecture.",
  ),
  noChargePoint: both(
    'Connected to Monta, but the account shows no charge point.',
    "Connecté à Monta, mais le compte n'a aucune borne.",
  ),
  refused: both(
    'Monta refused the client id or the client secret: check them (or reset the secret in the Monta portal), then save. No new automatic try; "Test the connection" tries once.',
    "Monta a refusé l'identifiant client ou le secret client : vérifiez-les (ou réinitialisez le secret dans le portail Monta), puis enregistrez. Aucun nouvel essai automatique ; « Tester la connexion » essaie une fois.",
  ),
  loginRejected: (status) =>
    both(
      `Monta rejected the token request (HTTP ${status}): check the credentials, or the Monta API changed. No new automatic try; "Test the connection" tries once.`,
      `Monta a rejeté la demande de jeton (HTTP ${status}) : vérifiez les identifiants, ou l'API Monta a changé. Aucun nouvel essai automatique ; « Tester la connexion » essaie une fois.`,
    ),
  forbidden: both(
    'Monta refuses to list the charge points (HTTP 403): give the application the "charge-points" scope in the Monta portal. No new automatic try; "Test the connection" tries once.',
    "Monta refuse de lister les bornes (HTTP 403) : donnez à l'application la portée « charge-points » dans le portail Monta. Aucun nouvel essai automatique ; « Tester la connexion » essaie une fois.",
  ),
  unreachable: (reason, wait) =>
    both(
      `Monta cannot be reached (${reason}). Next try in ${wait.en}.`,
      `Monta est injoignable (${reason}). Nouvel essai dans ${wait.fr}.`,
    ),
  rateLimited: (wait) =>
    both(
      `Monta asks to slow down (10 requests per minute for all your applications): pausing for ${wait.en}. Stopping a charge stays possible.`,
      `Monta demande de ralentir (10 requêtes par minute pour toutes vos applications) : pause de ${wait.fr}. Arrêter une charge reste possible.`,
    ),
  serverPaused: (wait) =>
    both(
      `Monta is unavailable: pausing for ${wait.en}. Stopping a charge stays possible.`,
      `Monta est indisponible : pause de ${wait.fr}. Arrêter une charge reste possible.`,
    ),
  busy: both(
    'A read of Monta is in progress: its result follows in the status.',
    "Une lecture de Monta est en cours : son résultat suivra dans l'état.",
  ),
  test: {
    cooldown: (wait) =>
      both(
        `Not read again before the refresh interval (in ${wait.en}). Last status:`,
        `Pas de nouvelle lecture avant l'intervalle de rafraîchissement (dans ${wait.fr}). Dernier état :`,
      ),
  },
};

/** Why a stop had no fresh read. */
export const REASONS = {
  pause: both('pause asked by Monta', 'pause demandée par Monta'),
  blocked: both('connection stopped', 'connexion arrêtée'),
  limit: both(
    'limit of 10 requests per minute of Monta',
    'limite de 10 requêtes par minute de Monta',
  ),
  time: both('no time left', 'plus le temps'),
};

/** Command errors: one language, the one of the configuration (Gladys shows the message as is). */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badButton: both('Invalid value for a button.', 'Valeur invalide pour un bouton.'),
  disabled: both(
    'Starting a charge is disabled: turn on "Allow starting a charge" in the configuration of the integration.',
    "Le démarrage d'une charge est désactivé : activez « Autoriser le démarrage d'une charge » dans la configuration de l'intégration.",
  ),
  unknownChargePoint: both(
    'This charge point is not (or no longer) on the Monta account.',
    "Cette borne n'est pas (ou plus) sur le compte Monta.",
  ),
  notReadYet: both(
    'The charge point was not read since the start: try again after the next read.',
    "La borne n'a pas été lue depuis le démarrage : réessayez après la prochaine lecture.",
  ),
  notConnected: both('Not connected to Monta.', 'Pas connecté à Monta.'),
  paused: (message) => message,
  stillRunning: both(
    'A command is still running on this charge point: try again in a few seconds.',
    'Une commande est encore en cours sur cette borne : réessayez dans quelques secondes.',
  ),
  noRoom: both(
    'The limit of Monta (10 requests per minute) is reached: the start was not sent, try again in a minute.',
    "La limite de Monta (10 requêtes par minute) est atteinte : le démarrage n'a pas été envoyé, réessayez dans une minute.",
  ),
  noVehicle: both('No vehicle is plugged in.', "Aucun véhicule n'est branché."),
  notReady: (state) =>
    both(
      `The charge point cannot start a charge now (${state.en}): the start was not sent.`,
      `La borne ne peut pas démarrer de charge maintenant (${state.fr}) : le démarrage n'a pas été envoyé.`,
    ),
  chargeInProgress: (state) =>
    both(
      `A charge is already in progress (${state.en}): the start was not sent.`,
      `Une charge est déjà en cours (${state.fr}) : le démarrage n'a pas été envoyé.`,
    ),
  stopMeanwhile: both(
    'A stop arrived meanwhile: the start was not sent.',
    "Un arrêt est arrivé entre-temps : le démarrage n'a pas été envoyé.",
  ),
  unknownState: (reason) =>
    both(
      `The state of the charge point could not be read (${reason}): the start was not sent.`,
      `L'état de la borne n'a pas pu être lu (${reason}) : le démarrage n'a pas été envoyé.`,
    ),
  noChargeKnown: (reason) =>
    both(
      `The charges could not be read (${reason.en}) and no charge in progress is known: nothing was sent.`,
      `Les charges n'ont pas pu être lues (${reason.fr}) et aucune charge en cours n'est connue : rien n'a été envoyé.`,
    ),
  noChargeFound: both(
    'The charge point is charging, but no charge in progress is among its charges of the last 7 days: nothing was sent. Stop it from the Monta app.',
    "La borne est en charge, mais aucune charge en cours ne figure parmi ses charges des 7 derniers jours : rien n'a été envoyé. Arrêtez-la depuis l'application Monta.",
  ),
  watchArmed: both(
    'No charge to stop yet, but a start sent may still land: it will be stopped as soon as a read shows it.',
    "Aucune charge à arrêter pour l'instant, mais un démarrage envoyé peut encore aboutir : il sera arrêté dès qu'une lecture le montrera.",
  ),
  credentialsRefused: both(
    'Monta refused the client id or the client secret: the command was not sent.',
    "Monta a refusé l'identifiant client ou le secret client : la commande n'a pas été envoyée.",
  ),
  tooSlow: both(
    'Monta answered too slowly: the command was not sent, try again.',
    "Monta a répondu trop lentement : la commande n'a pas été envoyée, réessayez.",
  ),
  notSent: (reason) =>
    both(`The command was not sent (${reason}).`, `La commande n'a pas été envoyée (${reason}).`),
  refused: (reason) =>
    both(`Monta refused the command (${reason}).`, `Monta a refusé la commande (${reason}).`),
  scope: both(
    'Monta refused the command (HTTP 403): give the application the "control-charging" scope in the Monta portal.',
    "Monta a refusé la commande (HTTP 403) : donnez à l'application la portée « control-charging » dans le portail Monta.",
  ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): the state follows at the next reads.`,
      `Commande envoyée, sans confirmation (${reason}) : l'état suivra aux prochaines lectures.`,
    ),
  pending: both(
    'Command sent, without confirmation yet: Monta is still answering, the state follows.',
    "Commande envoyée, sans confirmation pour l'instant : Monta répond encore, l'état suivra.",
  ),
};
