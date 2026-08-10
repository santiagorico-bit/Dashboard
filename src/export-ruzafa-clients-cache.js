import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cachePath = join(rootDir, "artifacts/cache/subscriptions-3043.json");
const outputPath = join(rootDir, "artifacts/lista-de-todos-los-clientes-ruzafa.json");

const cache = JSON.parse(await readFile(cachePath, "utf8"));
const byContact = new Map();

for (const subscription of Object.values(cache.subscriptions ?? {})) {
  const contact = subscription.contact ?? {};
  const key = String(contact["@id"] ?? subscription.contactId ?? contact.number ?? "");
  if (!key) continue;
  const existing = byContact.get(key);
  const subscriptions = existing?.subscriptions ?? [];
  subscriptions.push({
    id: subscription["@id"] ?? null,
    name: subscription.name ?? null,
    validFrom: subscription.validFrom ?? null,
    validThrough: subscription.validThrough ?? null,
    terminatedAt: subscription.terminatedAt ?? null,
    productCode: subscription.initialInfo?.productCode ?? null,
    tagName: subscription.tagName ?? null,
  });
  byContact.set(key, {
    contactId: key,
    number: contact.number ?? existing?.number ?? null,
    givenName: contact.givenName ?? existing?.givenName ?? null,
    familyName: contact.familyName ?? existing?.familyName ?? null,
    clubId: contact.clubId ?? existing?.clubId ?? null,
    subscriptions,
    lastValidFrom: subscription.validFrom ?? existing?.lastValidFrom ?? null,
  });
}

const rows = [...byContact.values()].sort((a, b) => {
  const nameA = `${a.familyName ?? ""} ${a.givenName ?? ""}`.trim().toLowerCase();
  const nameB = `${b.familyName ?? ""} ${b.givenName ?? ""}`.trim().toLowerCase();
  return nameA.localeCompare(nameB, "es");
});

const output = {
  generatedAt: new Date().toISOString(),
  source: "Resamania cache snapshot",
  club: "On Air Valencia Ruzafa",
  clubId: "/onairespana/clubs/3043",
  totalUniqueContacts: rows.length,
  contacts: rows,
};

await writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");
console.log(JSON.stringify({ file: outputPath, totalUniqueContacts: rows.length }, null, 2));
