/**
 * Signing a script in as an administrator.
 *
 * Shared by the bulk entry and legacy import scripts so they behave the same
 * way and there is one place that touches credentials.
 *
 * The password is read from a hidden prompt by default rather than an
 * environment variable. Passing it inline (`KILLER_ADMIN_PASSWORD=... npm run
 * ...`) writes it into your shell history, and it is easy to lose off the end of
 * a pasted command — which is exactly what happens in practice.
 */

import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { env, stdin, stdout } from 'node:process';
import { Amplify } from 'aws-amplify';
import { signIn } from 'aws-amplify/auth';
import { cognitoUserPoolsTokenProvider } from 'aws-amplify/auth/cognito';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../amplify/data/resource.js';

/**
 * Amplify's token provider expects browser storage. In a script there is none,
 * so give it a map — tokens live for the length of the process and no longer.
 */
function useInMemoryTokenStorage(): void {
  const store = new Map<string, string>();
  cognitoUserPoolsTokenProvider.setKeyValueStorage({
    setItem: async (key: string, value: string) => void store.set(key, value),
    getItem: async (key: string) => store.get(key) ?? null,
    removeItem: async (key: string) => void store.delete(key),
    clear: async () => void store.clear(),
  });
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Prompt without echoing, so the password never appears on screen. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stdout.write(question);

    // `stdin` may not be a TTY (piped input, CI). Fall back to a plain read
    // rather than failing, since the alternative is no way in at all.
    if (!stdin.isTTY) {
      const rl = createInterface({ input: stdin });
      rl.question('', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        switch (char) {
          case '\n':
          case '\r':
          case '': // Ctrl-D
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onData);
            stdout.write('\n');
            resolve(value);
            return;
          case '': // Ctrl-C
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onData);
            stdout.write('\n');
            reject(new Error('Cancelled.'));
            return;
          case '': // backspace
          case '\b':
            value = value.slice(0, -1);
            break;
          default:
            // Ignore other control characters.
            if (char >= ' ') value += char;
        }
      }
    };

    stdin.on('data', onData);
  });
}

export type AdminClient = ReturnType<typeof generateClient<Schema>>;

export interface AdminSession {
  client: AdminClient;
  email: string;
}

/**
 * Configure Amplify against a given outputs file and sign in as an ADMIN user.
 *
 * Credentials come from `--email`/`KILLER_ADMIN_EMAIL` and
 * `KILLER_ADMIN_PASSWORD`, falling back to prompts for whatever is missing.
 */
export async function openAdminSession(
  outputsPath: string,
  emailFromFlag?: string | null,
): Promise<AdminSession> {
  const outputs = JSON.parse(await readFile(outputsPath, 'utf8')) as Record<string, unknown>;
  useInMemoryTokenStorage();
  Amplify.configure(outputs as Parameters<typeof Amplify.configure>[0]);

  const poolId = (outputs['auth'] as { user_pool_id?: string } | undefined)?.user_pool_id;
  console.log(`Using ${outputsPath} (user pool ${poolId ?? 'unknown'})`);

  const email =
    emailFromFlag || env['KILLER_ADMIN_EMAIL'] || (await ask('Admin email: '));
  if (!email) throw new Error('An admin email is required.');

  const password =
    env['KILLER_ADMIN_PASSWORD'] || (await askHidden(`Password for ${email}: `));
  if (!password) throw new Error('A password is required.');

  const result = await signIn({ username: email, password });
  if (result.nextStep.signInStep !== 'DONE') {
    throw new Error(
      `That account needs "${result.nextStep.signInStep}" first. Sign in through the website once, then rerun.`,
    );
  }

  console.log(`Signed in as ${email}.\n`);
  return { client: generateClient<Schema>({ authMode: 'userPool' }), email };
}

/**
 * Custom operations declare `.returns(a.json())`, which is AppSync's AWSJSON
 * scalar — it serialises to a JSON string on the way out, so it has to be
 * parsed back.
 */
export function payload<T>(data: unknown): T {
  return (typeof data === 'string' ? JSON.parse(data) : data) as T;
}
