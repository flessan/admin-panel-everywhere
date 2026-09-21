import { ApiInputError } from './request.js';
const shell = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;

/** Input MUST be a connector-produced redacted preview, never raw form values. */
export function generateExamples(preview) {
  let url;
  try { url = new URL(preview.url); } catch { throw new ApiInputError('A valid connector request preview is required.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new ApiInputError('Unsafe request URL.');
  if (!['none', 'bearer'].includes(preview.authentication)) throw new ApiInputError('Examples for this authentication scheme require a compatible connector.');
  const auth = preview.authentication === 'bearer';
  const externalBody = preview.bodyKind === 'binary' || preview.bodyOmitted === true;
  const headers = Object.fromEntries(Object.entries(preview.headers).filter(([name]) => name.toLowerCase() !== 'authorization'));
  const curl = ['# Credential/body placeholders must be supplied at runtime; do not paste real secrets into source.',
    `curl --globoff ${preview.method === 'HEAD' ? '--head' : `--request ${shell(preview.method)}`} --url ${shell(preview.url)}`];
  if (auth) curl.push('  --header "Authorization: Bearer ${API_TOKEN:?Set API_TOKEN at runtime}"');
  for (const [key, value] of Object.entries(headers)) curl.push(`  --header ${shell(`${key}: ${value}`)}`);
  const body = preview.bodyKind === 'json' ? JSON.stringify(preview.body) : preview.body;
  if (externalBody) curl.push("  --data-binary '@/path/to/upload.bin'");
  else if (preview.bodyKind !== 'none') curl.push(`  --data-raw ${shell(body)}`);
  const jsHeaders = JSON.stringify(headers, null, 2);
  const javascript = [
    '// Redacted body values are placeholders. Supply request-specific secrets at runtime.',
    `async function sendRequest({ ${[...(auth ? ['apiToken'] : []), ...(externalBody ? ['bodyFile'] : [])].join(', ')} } = {}) {`,
    ...(auth ? ['  if (!apiToken) throw new Error("A runtime API token is required.");'] : []),
    ...(externalBody ? ['  if (!bodyFile) throw new Error("A runtime Blob/File containing the request body is required.");'] : []),
    `  const headers = ${jsHeaders};`,
    ...(auth ? ['  headers.Authorization = "Bearer " + apiToken;'] : []),
    `  return fetch(${JSON.stringify(preview.url)}, {`,
    `    method: ${JSON.stringify(preview.method)}, headers,`,
    ...(externalBody ? ['    body: bodyFile,'] : preview.bodyKind !== 'none' ? [`    body: ${JSON.stringify(String(body))},`] : []),
    '    credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer"',
    '  });', '}', '// The returned Response may contain sensitive data. Do not log or persist it.',
  ].join('\n');
  return { curl: curl[0] + '\n' + curl.slice(1).join(' \\\n'), javascript };
}
