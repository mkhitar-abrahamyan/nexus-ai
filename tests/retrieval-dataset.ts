/**
 * The stored retrieval dataset: a support knowledge base and the questions asked of it, with the
 * article that answers each.
 *
 * Three kinds of question, as real traffic has them:
 * - an exact identifier (an error code, a SKU, a setting) that only keyword search can pin down;
 * - a paraphrase that shares no word with the article, which only meaning can find;
 * - a mix of both.
 *
 * `conceptEmbed` is the embedding the vector side uses. It is deterministic and needs no model. It
 * maps words to concepts through a synonym table, so paraphrases land close together, and, like real
 * embedding models, it carries almost nothing for codes and numbers.
 */

export interface SupportArticle {
  id: string;
  content: string;
}

export interface SupportQuestion {
  id: string;
  query: string;
  /** The article that answers it. */
  relevant: string;
  kind: 'identifier' | 'paraphrase' | 'mixed';
}

export const ARTICLES: SupportArticle[] = [
  {
    id: 'a01',
    content:
      'Error ERR-4012 appears when an upload exceeds the storage quota of the workspace. Delete old files or upgrade the plan.',
  },
  { id: 'a02', content: 'Error ERR-4013 means the upload was interrupted. Retry the transfer on a stable connection.' },
  { id: 'a03', content: 'Error ERR-5001 is returned when the billing processor declines the payment card.' },
  { id: 'a04', content: 'Error ERR-5002 shows when the invoice address does not match the card country.' },
  { id: 'a05', content: 'Login failures: when users are unable to log on, reset the password from the security page.' },
  { id: 'a06', content: 'Two-step verification codes arrive by text message. Lost phone? Use a recovery code.' },
  { id: 'a07', content: 'To remove a teammate, open members, choose the person, and revoke their seat.' },
  { id: 'a08', content: 'Exports of reports run overnight and are emailed as spreadsheets when finished.' },
  { id: 'a09', content: 'The SKU NX-220 router ships with firmware 3.4 and supports mesh pairing.' },
  { id: 'a10', content: 'The SKU NX-330 router adds a second band and parental controls.' },
  { id: 'a11', content: 'Refunds are issued to the original payment method within ten business days.' },
  { id: 'a12', content: 'Cancel a subscription from the plan page; access lasts until the period ends.' },
  { id: 'a13', content: 'Webhook retries use exponential backoff for up to 24 hours before the endpoint is disabled.' },
  { id: 'a14', content: 'Set MAX_CONCURRENT_JOBS to limit how many imports run at once on a worker.' },
  { id: 'a15', content: 'Set IMPORT_BATCH_ROWS to change how many rows an import commits in one transaction.' },
  { id: 'a16', content: 'Dark theme follows the operating system unless chosen in appearance preferences.' },
  { id: 'a17', content: 'Single sign-on with SAML requires the identity provider metadata URL from your admin.' },
  { id: 'a18', content: 'Audit logs keep every administrative action for one year and can be streamed to storage.' },
  {
    id: 'a19',
    content: 'Error ERR-7104 occurs when an API token has expired; create a new token in developer settings.',
  },
  { id: 'a20', content: 'Error ERR-7105 occurs when an API token lacks the scope a request needs.' },
  { id: 'a21', content: 'Shipping to remote islands adds three days and a handling fee.' },
  { id: 'a22', content: 'Damaged parcels: photograph the box and file a claim within 48 hours of delivery.' },
  { id: 'a23', content: 'The mobile app works offline and syncs edits when the device reconnects.' },
  { id: 'a24', content: 'Calendar sync supports read and write for shared team calendars.' },
  { id: 'a25', content: 'Firmware 3.5 for the NX-220 fixes dropped connections after sleep.' },
  { id: 'a26', content: 'Bulk invite people by uploading a list of addresses; each receives a join link.' },
  { id: 'a27', content: 'Data residency: workspaces created in the EU region keep files in Frankfurt.' },
  { id: 'a28', content: 'Rate limits allow 600 requests per minute per token; bursts above that return status 429.' },
  { id: 'a29', content: 'Change the email address on the profile page; a confirmation goes to the new address.' },
  { id: 'a30', content: 'Deleting a workspace is permanent after a 30 day grace period.' },
  // Look-alike codes: an embedding sees "an error" in each of them, and little else.
  { id: 'a31', content: 'Error ERR-4014 is shown when a file name contains characters the storage does not allow.' },
  { id: 'a32', content: 'Error ERR-4015 is shown when a folder is shared with more people than the plan allows.' },
  { id: 'a33', content: 'Error ERR-4016 is shown when a file is locked by another editor.' },
  { id: 'a34', content: 'Error ERR-4017 is shown when a version is restored over a newer one.' },
  { id: 'a35', content: 'Error ERR-5003 is shown when a coupon has expired.' },
  { id: 'a36', content: 'Error ERR-5004 is shown when a tax number is not recognised.' },
  { id: 'a37', content: 'Error ERR-7106 is shown when a request is signed with the wrong secret.' },
  { id: 'a38', content: 'Error ERR-7107 is shown when a request arrives from an address outside the allow list.' },
  { id: 'a39', content: 'The SKU NX-110 router is the entry model with a single band.' },
  { id: 'a40', content: 'The SKU NX-440 router adds a fibre port and a second band.' },
  { id: 'a41', content: 'The SKU NX-550 router is built for offices with many devices.' },
];

export const QUESTIONS: SupportQuestion[] = [
  // Exact identifiers: the code is the whole question.
  { id: 'q01', query: 'ERR-4012', relevant: 'a01', kind: 'identifier' },
  { id: 'q02', query: 'what is ERR-4013', relevant: 'a02', kind: 'identifier' },
  { id: 'q03', query: 'ERR-5001 error', relevant: 'a03', kind: 'identifier' },
  { id: 'q04', query: 'getting ERR-5002', relevant: 'a04', kind: 'identifier' },
  { id: 'q05', query: 'ERR-7104 error', relevant: 'a19', kind: 'identifier' },
  { id: 'q06', query: 'ERR-7105', relevant: 'a20', kind: 'identifier' },
  { id: 'q07', query: 'NX-330', relevant: 'a10', kind: 'identifier' },
  { id: 'q08', query: 'MAX_CONCURRENT_JOBS', relevant: 'a14', kind: 'identifier' },
  { id: 'q09', query: 'IMPORT_BATCH_ROWS setting', relevant: 'a15', kind: 'identifier' },
  { id: 'q10', query: 'status 429', relevant: 'a28', kind: 'identifier' },
  { id: 'q25', query: 'ERR-4014', relevant: 'a31', kind: 'identifier' },
  { id: 'q26', query: 'seeing ERR-4015', relevant: 'a32', kind: 'identifier' },
  { id: 'q27', query: 'ERR-4016 error', relevant: 'a33', kind: 'identifier' },
  { id: 'q28', query: 'ERR-4017', relevant: 'a34', kind: 'identifier' },
  { id: 'q29', query: 'what does ERR-5003 mean', relevant: 'a35', kind: 'identifier' },
  { id: 'q30', query: 'ERR-5004', relevant: 'a36', kind: 'identifier' },
  { id: 'q31', query: 'ERR-7106 error', relevant: 'a37', kind: 'identifier' },
  { id: 'q32', query: 'ERR-7107', relevant: 'a38', kind: 'identifier' },
  { id: 'q33', query: 'NX-110', relevant: 'a39', kind: 'identifier' },
  { id: 'q34', query: 'NX-440 specs', relevant: 'a40', kind: 'identifier' },
  { id: 'q35', query: 'NX-550', relevant: 'a41', kind: 'identifier' },
  // Paraphrases: no word in common with the article.
  { id: 'q11', query: "I can't sign in to my account", relevant: 'a05', kind: 'paraphrase' },
  { id: 'q12', query: 'how do I get my money back', relevant: 'a11', kind: 'paraphrase' },
  { id: 'q13', query: 'stop paying monthly', relevant: 'a12', kind: 'paraphrase' },
  { id: 'q14', query: 'kick a colleague out', relevant: 'a07', kind: 'paraphrase' },
  { id: 'q15', query: 'night mode', relevant: 'a16', kind: 'paraphrase' },
  { id: 'q16', query: 'my package arrived broken', relevant: 'a22', kind: 'paraphrase' },
  { id: 'q17', query: 'use it without internet', relevant: 'a23', kind: 'paraphrase' },
  { id: 'q18', query: 'where are my documents physically kept in Europe', relevant: 'a27', kind: 'paraphrase' },
  { id: 'q19', query: 'add many coworkers at once', relevant: 'a26', kind: 'paraphrase' },
  { id: 'q20', query: 'history of what admins did', relevant: 'a18', kind: 'paraphrase' },
  // Mixed: an identifier and a description.
  { id: 'q21', query: 'NX-220 keeps losing wifi after standby', relevant: 'a25', kind: 'mixed' },
  { id: 'q22', query: 'ERR-4012 out of space', relevant: 'a01', kind: 'mixed' },
  { id: 'q23', query: 'card refused ERR-5001', relevant: 'a03', kind: 'mixed' },
  { id: 'q24', query: 'expired key ERR-7104', relevant: 'a19', kind: 'mixed' },
];

/** Words that mean the same thing, mapped to one concept. */
const CONCEPTS: Record<string, string> = {
  sign: 'login',
  log: 'login',
  login: 'login',
  logon: 'login',
  on: '',
  in: '',
  account: 'login',
  password: 'login',
  unable: 'fail',
  cant: 'fail',
  "can't": 'fail',
  failure: 'fail',
  failures: 'fail',
  money: 'refund',
  back: 'refund',
  refund: 'refund',
  refunds: 'refund',
  issued: 'refund',
  paying: 'subscription',
  monthly: 'subscription',
  subscription: 'subscription',
  cancel: 'subscription',
  plan: 'subscription',
  stop: 'subscription',
  kick: 'remove',
  out: 'remove',
  remove: 'remove',
  revoke: 'remove',
  colleague: 'member',
  teammate: 'member',
  coworkers: 'member',
  members: 'member',
  person: 'member',
  people: 'member',
  night: 'dark',
  dark: 'dark',
  mode: 'theme',
  theme: 'theme',
  appearance: 'theme',
  package: 'parcel',
  parcels: 'parcel',
  parcel: 'parcel',
  arrived: 'delivery',
  delivery: 'delivery',
  broken: 'damage',
  damaged: 'damage',
  internet: 'offline',
  without: 'offline',
  offline: 'offline',
  reconnects: 'offline',
  documents: 'files',
  files: 'files',
  kept: 'residency',
  physically: 'residency',
  residency: 'residency',
  europe: 'eu',
  eu: 'eu',
  frankfurt: 'eu',
  many: 'bulk',
  once: 'bulk',
  bulk: 'bulk',
  add: 'invite',
  invite: 'invite',
  history: 'audit',
  admins: 'admin',
  administrative: 'admin',
  did: 'action',
  action: 'action',
  audit: 'audit',
  logs: 'audit',
  wifi: 'connection',
  losing: 'drop',
  dropped: 'drop',
  connections: 'connection',
  standby: 'sleep',
  sleep: 'sleep',
  router: 'router',
  space: 'quota',
  quota: 'quota',
  storage: 'quota',
  exceeds: 'quota',
  card: 'payment',
  refused: 'decline',
  declines: 'decline',
  payment: 'payment',
  billing: 'payment',
  expired: 'expired',
  key: 'token',
  token: 'token',
  error: 'error',
  err: 'error',
  sku: '',
  getting: '',
  what: '',
  is: '',
  how: '',
  do: '',
  get: '',
  my: '',
  the: '',
  a: '',
  i: '',
  to: '',
  at: '',
};

/** An embedding by concept: paraphrases land together, codes and numbers carry almost nothing. */
export function conceptEmbed(texts: string[], dimensions = 128): number[][] {
  return texts.map((text) => {
    const vector = new Array<number>(dimensions).fill(0);
    // Letters only: an identifier is read as its words, and its digits carry nothing, as in real models.
    for (const raw of text.toLowerCase().match(/[a-z']+/g) ?? []) {
      const concept = CONCEPTS[raw] ?? raw.replace(/s$/, '');
      if (!concept) continue;
      let hash = 17;
      for (const char of concept) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      vector[hash % dimensions] += 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => value / norm);
  });
}
