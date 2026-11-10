/** Google Drive backup — NOT configured in this build.
 *
 *  Honest status: no OAuth Client ID exists, no Google Cloud project exists,
 *  and no real-account test was possible in the sandbox. The Drive button in
 *  Settings is therefore shipped DISABLED with the exact blocker text below.
 *  Gmail inbox is not a backup.
 *
 *  To enable (free, owner does this once, ~15 minutes):
 *  1. Go to https://console.cloud.google.com/ — sign in with the Google
 *     account that will own the backups. Create a project (free, no billing).
 *  2. Left menu: APIs & Services > Library — enable "Google Drive API".
 *  3. APIs & Services > OAuth consent screen — choose "External", fill the
 *     app name + your email, add scope `https://www.googleapis.com/auth/drive.file`
 *     (narrowest useful scope: only files this app creates), add yourself as a
 *     Test user, save. NOTE: while the app is in "Testing" mode, Google
 *     refresh tokens expire after 7 days and only Test users can sign in;
 *     publishing the consent screen (verification) removes the 7-day limit.
 *  4. APIs & Services > Credentials > Create Credentials > OAuth client ID >
 *     "Web application". Add Authorized JavaScript origin = the exact site
 *     origin where the app is hosted (e.g. https://<user>.github.io).
 *     Copy the Client ID.
 *  5. In the app: Settings > Google Drive > paste the Client ID, tap
 *     "Connect Google Drive". The app then uses Google Identity Services
 *     (token client, drive.file scope) to upload / list / download / restore
 *     backup JSON files. Tokens live only in memory for the session.
 *  6. Test with a real account: upload a backup, delete it from the phone,
 *     restore from Drive, verify trip counts match.
 *
 *  Implementation hook: when a Client ID is present, `initDrive(clientId)`
 *  loads https://accounts.google.com/gsi/client and wires the token client;
 *  until then every Drive call returns DRIVE_NOT_CONFIGURED.
 */
export const DRIVE_BLOCKER_TEXT =
  "Not configured: Google OAuth Client ID missing. See Settings > Google Drive setup steps (free, ~15 min, needs the owner's Google account).";

export const DRIVE_NOT_CONFIGURED = "DRIVE_NOT_CONFIGURED" as const;

export function driveStatus(): { configured: boolean; blocker: string | null } {
  const clientId = (typeof localStorage !== "undefined" ? localStorage.getItem("drive_client_id") : null) ?? null;
  if (!clientId) return { configured: false, blocker: DRIVE_BLOCKER_TEXT };
  return { configured: true, blocker: null };
}

export async function driveUpload(_backupJson: string): Promise<never> {
  throw new Error(DRIVE_BLOCKER_TEXT);
}
export async function driveList(): Promise<never> {
  throw new Error(DRIVE_BLOCKER_TEXT);
}
export async function driveDownload(_fileId: string): Promise<never> {
  throw new Error(DRIVE_BLOCKER_TEXT);
}
