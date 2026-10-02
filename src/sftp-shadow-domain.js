import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export const SUPPORTED_ENTITIES = ["abonnements", "resiliations", "factures", "passages", "contacts", "articles", "paiements"];

export function entityFromFilename(filename) {
  const normalized = filename.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return SUPPORTED_ENTITIES.find((entity) => normalized.includes(entity)) ?? null;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function normalizedRecord(record) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [
    key.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, ""),
    typeof value === "string" ? value.trim() : value,
  ]));
}

const first = (row, candidates) => candidates.map((key) => row[key]).find((value) => value !== undefined && value !== "") ?? null;

export function safePayload(record) {
  const denied = /(email|mail|phone|telephone|mobile|address|adresse|postal|zipcode|firstname|lastname|surname|birth|birthday|iban|bic|mandate|password)/i;
  const allowed = /(uid|state|status|club|membership|abonnement|product|produit|article|family|famille|billing|rhythm|date|time|created|updated|deleted|authorized|crossing|point|passage|type|zone|reason|motif|invoice|facture|reference|channel|quantity|quantite|price|prix|tax|tva|financial|source|goal|objectif|salesperson|commercial|amount|montant|payment|paiement)/i;
  return Object.fromEntries(Object.entries(record).filter(([key]) => allowed.test(key) && !denied.test(key)));
}

export function mapRecord(entity, record, ordinal = 0) {
  const row = normalizedRecord(record);
  const externalUid = first(row, [
    "uid", `${entity.slice(0, -1)}uid`, "lineuid", "ligneuid", "invoiceuid", "factureuid", "paymentuid", "paiementuid",
  ]) ?? createHash("sha256").update(`${entity}:${JSON.stringify(row)}:${ordinal}`).digest("hex");
  return {
    externalUid: String(externalUid),
    clubCode: first(row, ["clubcode", "codeclub", "clubuid", "uidclub"]),
    contactUid: first(row, ["contactuid", "uidcontact", "memberuid", "clientuid"]),
    occurredAt: first(row, ["crossedat", "passageat", "generatedat", "invoicedate", "paymentdate", "receptiondate", "cancellationdate", "createdat"]),
    sourceUpdatedAt: first(row, ["updatedat", "modifiedat", "lastupdatedat"]),
    sourceDeletedAt: first(row, ["deletedat", "removedat"]),
    payload: safePayload(record),
  };
}

export function isCsvFile(item) {
  return item?.type !== "d" && /\.csv$/i.test(item?.name ?? "") && entityFromFilename(item.name);
}
