// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, buttons, device and feature names,
// order statuses), in English and French.
// -----------------------------------------------------------------------------

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

/** What a date feature shows when there is nothing to show. */
export const NONE = '—';

export const DEVICE_NAME = { en: 'Picnic', fr: 'Picnic' };

/** Feature names, in the language chosen in the configuration. */
export const FEATURE_NAMES = {
  'next-slot-start': {
    en: 'Next delivery: slot start',
    fr: 'Prochaine livraison : début du créneau',
  },
  'next-slot-end': { en: 'Next delivery: slot end', fr: 'Prochaine livraison : fin du créneau' },
  eta: { en: 'Next delivery: estimated arrival', fr: 'Prochaine livraison : arrivée estimée' },
  'order-cut-off': { en: 'Order before', fr: 'Commander avant' },
  'last-order-status': { en: 'Last order status', fr: 'État de la dernière commande' },
  'cart-items': { en: 'Cart: articles', fr: 'Panier : articles' },
  'cart-total': { en: 'Cart: total', fr: 'Panier : total' },
};

/** Delivery statuses of Picnic; any other one is shown as Picnic sends it. */
export const STATUS_NAMES = {
  CURRENT: { en: 'Upcoming', fr: 'À venir' },
  COMPLETED: { en: 'Delivered', fr: 'Livrée' },
  CANCELLED: { en: 'Cancelled', fr: 'Annulée' },
};

/** "25 min" / "3 h", for the pauses. */
export function age(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) {
    return { en: `${minutes} min`, fr: `${minutes} min` };
  }
  const hours = Math.round(minutes / 60);
  return { en: `${hours} h`, fr: `${hours} h` };
}

const both = (en, fr) => ({ en, fr });

export const T = {
  noCredentials: both(
    'Enter the e-mail, the password and the country of your Picnic account (the ones of the app).',
    "Saisissez l'e-mail, le mot de passe et le pays de votre compte Picnic (ceux de l'application).",
  ),
  connecting: both('Signing in to Picnic…', 'Connexion à Picnic…'),
  connected: (next) =>
    next
      ? both(
          `Connected to Picnic. Next delivery: ${next}. Open Discovery to add the Picnic device.`,
          `Connecté à Picnic. Prochaine livraison : ${next}. Ouvrez Découverte pour ajouter l'appareil Picnic.`,
        )
      : both(
          'Connected to Picnic, no delivery planned. Open Discovery to add the Picnic device.',
          "Connecté à Picnic, aucune livraison prévue. Ouvrez Découverte pour ajouter l'appareil Picnic.",
        ),
  refused: both(
    'Picnic refused the e-mail or the password: check them and the country in the configuration. The integration waits for a change (or the test button).',
    "Picnic a refusé l'e-mail ou le mot de passe : vérifiez-les, ainsi que le pays, dans la configuration. L'intégration attend une modification (ou le bouton de test).",
  ),
  twoFactor: both(
    'Picnic asks for a verification code. In this configuration screen: 1) "Send the verification code" (SMS or e-mail), 2) type the code you received in "Verify the code".',
    'Picnic demande un code de vérification. Dans cet écran de configuration : 1) « Envoyer le code de vérification » (SMS ou e-mail), 2) saisissez le code reçu dans « Vérifier le code ».',
  ),
  sessionRefused: both(
    'Picnic refused the session again right after a new sign-in: the integration stopped. Click "Test the connection" to try once more.',
    "Picnic a de nouveau refusé la session juste après une nouvelle connexion : l'intégration s'est arrêtée. Cliquez sur « Tester la connexion » pour réessayer une fois.",
  ),
  unreachable: (reason, wait) =>
    both(
      `Picnic cannot be reached (${reason}). Next try in ${wait.en}.`,
      `Picnic est injoignable (${reason}). Nouvel essai dans ${wait.fr}.`,
    ),
  rateLimited: (wait) =>
    both(
      `Picnic asks to slow down: pausing for ${wait.en}.`,
      `Picnic demande de ralentir : pause de ${wait.fr}.`,
    ),
  forbidden: (wait) =>
    both(
      `Picnic refuses the requests (HTTP 403): pausing for ${wait.en}.`,
      `Picnic refuse les requêtes (HTTP 403) : pause de ${wait.fr}.`,
    ),
  code: {
    needsFields: both(
      'This version of Gladys did not send the form of the button: update Gladys.',
      "Cette version de Gladys n'a pas envoyé le formulaire du bouton : mettez Gladys à jour.",
    ),
    sent: (channel) =>
      channel === 'email'
        ? both(
            'Picnic is sending a code by e-mail. Type it in "Verify the code".',
            'Picnic envoie un code par e-mail. Saisissez-le dans « Vérifier le code ».',
          )
        : both(
            'Picnic is sending a code by SMS. Type it in "Verify the code".',
            'Picnic envoie un code par SMS. Saisissez-le dans « Vérifier le code ».',
          ),
    notNeeded: both(
      'Picnic accepted the sign-in without a code: connected.',
      'Picnic a accepté la connexion sans code : connecté.',
    ),
    cooldown: both(
      'A code was requested less than a minute ago: wait for it, or try again in a minute.',
      "Un code a été demandé il y a moins d'une minute : attendez-le, ou réessayez dans une minute.",
    ),
    noPending: both(
      'No sign-in is waiting for a code: click "Send the verification code" first.',
      "Aucune connexion n'attend de code : cliquez d'abord sur « Envoyer le code de vérification ».",
    ),
    badFormat: both(
      'The code is made of 4 to 10 digits.',
      'Le code est composé de 4 à 10 chiffres.',
    ),
    refused: both(
      'Picnic refused the code: check it, or ask for a new one.',
      'Picnic a refusé le code : vérifiez-le, ou demandez-en un nouveau.',
    ),
    expired: both(
      'The sign-in waiting for this code expired: click "Send the verification code" again.',
      'La connexion qui attendait ce code a expiré : cliquez à nouveau sur « Envoyer le code de vérification ».',
    ),
    verified: both('Code accepted: connected to Picnic.', 'Code accepté : connecté à Picnic.'),
    failed: (reason) =>
      both(
        `Picnic could not be reached (${reason}): try again in a moment.`,
        `Picnic est injoignable (${reason}) : réessayez dans un moment.`,
      ),
  },
  test: {
    cooldown: both(
      'Already read less than 30 seconds ago.',
      'Déjà lu il y a moins de 30 secondes.',
    ),
    summary: ({ next, status, count, total }) =>
      both(
        `Next delivery: ${next ?? 'none'}. Last order: ${status?.en ?? 'none'}. Cart: ${count ?? '?'} articles, ${total ?? '?'} €.`,
        `Prochaine livraison : ${next ?? 'aucune'}. Dernière commande : ${status?.fr ?? 'aucune'}. Panier : ${count ?? '?'} articles, ${total ?? '?'} €.`,
      ),
  },
};
