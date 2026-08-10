import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ResamaniaApiClient } from "./resamania-api-client.js";
import { assertAppLoaded, verifySession } from "./resamania-session.js";
import {
  contactOf, hasPriorFormulaChange, isCdd, isEligibleCancellation, isFormulaChange,
  isDayPassSession, isEligibleActiveMember, isPreEligibleMembership, isSession, isTieSession,
  isShortNoticeFullPeriodCancellation, isShortPass, isValidInvoice, isVip, isWebOffer,
  normalizeState, normalizeText, paymentIssueLabel, productCode, signatureIssueLabel,
  tallyStates,
} from "./dashboard-domain.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = `${rootDir}/artifacts`;
const profileDir = process.env.BROWSER_PROFILE_DIR ?? `${rootDir}/.browser-profile-group`;
const appBase = "https://app.resamania.com/onairespana";
const apiBase = "https://api.resamania.com/onairespana";
const clubs = [
  ["barcelona", "Barcelona Universitat", "3046"],
  ["madrid", "Madrid Delicias", "3044"],
  ["malaga-armengual", "Málaga Armengual", "3045"],
  ["malaga-soho", "Málaga Soho", "3270"],
  ["les-arts", "Valencia Les Arts", "3041"],
  ["nuevo-centro", "Valencia Nuevo Centro", "3042"],
  ["ruzafa", "Valencia Ruzafa", "3043"],
];
const clubSelectorLabels = {
  barcelona: "On Air Barcelona Universitat",
  madrid: "On Air Madrid Delicias",
  "malaga-armengual": "On Air Malaga Armengual",
  "malaga-soho": "On Air Málaga Soho",
  "les-arts": "On Air Valencia Les Arts",
  "nuevo-centro": "On Air Valencia Nuevo Centro",
  ruzafa: "On Air Valencia Ruzafa",
};
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const monthStart = `${today.slice(0, 8)}01`;
const fitnessKpiEnabledProductCodes = new Set(["cdi1", "cdi2", "cdi3"]);
await mkdir(artifactsDir, { recursive: true });
let fitnessKpiSnapshot = null;
try {
  fitnessKpiSnapshot = JSON.parse(await readFile(`${artifactsDir}/fitness-kpi-live.json`, "utf8"));
} catch {}
async function collect([slug, name, id]) {
  let context;
  let api;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless: true,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(appBase, { waitUntil: "domcontentloaded", timeout: 45000 });
    // Si el perfil ha perdido la sesión, aquí ya estamos en el login: cortar
    // ahora evita 15 s esperando un selector de club que no va a aparecer.
    await assertAppLoaded(page, { club: name });
    const targetClub = page.getByRole("button", { name: clubSelectorLabels[slug], exact: true });
    if (!(await targetClub.isVisible().catch(() => false))) {
      const clubButton = page.getByRole("button", { name: "Club", exact: true });
      if (await clubButton.isVisible().catch(() => false)) await clubButton.click();
    }
    await targetClub.waitFor({ state: "visible", timeout: 15000 });
    await targetClub.click();
    await page.waitForTimeout(1500);
    await page.goto("about:blank");
    let contactsResponse = null;
    page.on("response", (response) => {
      if (response.url().startsWith(`${apiBase}/contacts?`) && response.status() === 200) {
        contactsResponse = response;
      }
    });
    await page.goto(
      `${appBase}/-/management/infinite-lists/memberships/members?clubId=%2Fonairespana%2Fclubs%2F${id}`,
      { waitUntil: "domcontentloaded", timeout: 45000 },
    );
    for (let attempt = 0; attempt < 30 && !contactsResponse; attempt += 1) {
      await page.waitForTimeout(500);
    }
    if (!contactsResponse) {
      // Distingue "sesión caducada" de "la lista tardó demasiado": el mensaje
      // genérico obligaba a adivinar cuál de las dos cosas había pasado.
      await assertAppLoaded(page, { club: name });
      throw new Error("No se cargó la sesión de datos del club");
    }
    const rawHeaders = await contactsResponse.request().allHeaders();
    const headers = Object.fromEntries(
      Object.entries(rawHeaders).filter(([header]) => !header.startsWith(":")),
    );
    const clubId = `/onairespana/clubs/${id}`;
    api = await new ResamaniaApiClient({
      request: context.request,
      baseUrl: apiBase,
      headers,
      clubId,
      cacheFile: `${artifactsDir}/cache/subscriptions-${id}.json`,
      concurrency: 6,
      retries: 4,
    }).init();
    // Que el navegador tenga sesión no garantiza que las cabeceras capturadas
    // sirvan al reproducirlas desde context.request. Una sonda barata lo cierra.
    await verifySession(context.request, { baseUrl: apiBase, headers, club: name });
    const motivesPayload = (await api.get("/referentials/cancellation_motives", {
      endpoint: "referentials.cancellationMotives", allowStatuses: [400, 403, 404],
    })).data ?? {};
    const motiveNames = new Map(
      (motivesPayload["hydra:member"] ?? []).map((motive) => [
        motive["@id"],
        motive.name ?? motive.label ?? motive.wording ?? "",
      ]),
    );
    const cancellationScanStart = new Date(`${monthStart}T00:00:00+02:00`);
    cancellationScanStart.setMonth(cancellationScanStart.getMonth() - 2);
    const cancellationScanStartText = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(cancellationScanStart);
    const allCancellations = [];
    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      const params = new URLSearchParams({
        clubId,
        "order[createdAt]": "desc",
        itemsPerPage: "100",
        page: String(pageNumber),
      });
      const payload = await api.getJson("/cancellations", {
        endpoint: "cancellations.list", params: Object.fromEntries(params),
      });
      const members = payload["hydra:member"] ?? [];
      allCancellations.push(...members);
      const oldest = members.at(-1)?.createdAt?.slice(0, 10);
      if (!payload["hydra:view"]?.["hydra:next"] || (oldest && oldest < cancellationScanStartText)) break;
    }
    const subscriptionHistory = [];
    for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
      const subscriptionParams = new URLSearchParams({
        "contact.clubId": clubId,
        "order[validFrom]": "desc",
        itemsPerPage: "100",
        page: String(pageNumber),
      });
      const subscriptionPayload = await api.getJson("/subscriptions", {
        endpoint: "subscriptions.list", params: Object.fromEntries(subscriptionParams),
      });
      const members = subscriptionPayload["hydra:member"] ?? [];
      subscriptionHistory.push(...members);
      const oldest = members.at(-1)?.validFrom;
      if (!subscriptionPayload["hydra:view"]?.["hydra:next"] || (oldest && oldest < monthStart)) break;
    }
    const subscriptionsByContact = new Map();
    for (const subscription of subscriptionHistory) {
      const contactId = contactOf(subscription);
      if (!contactId) continue;
      if (!subscriptionsByContact.has(contactId)) subscriptionsByContact.set(contactId, []);
      subscriptionsByContact.get(contactId).push(subscription);
    }
    const startsInCurrentMonth = (item) => {
      const validFrom = item.validFrom?.slice(0, 10);
      return Boolean(validFrom && validFrom >= monthStart && validFrom <= today);
    };
    const subscriptions = subscriptionHistory.filter(startsInCurrentMonth);
    const preEligibleMembershipSubscriptions = subscriptions.filter((item) =>
      isPreEligibleMembership(item, { from: monthStart, to: today, enabledCodes: fitnessKpiEnabledProductCodes })
    );
    const fullPriorFormulaFlags = await Promise.all(preEligibleMembershipSubscriptions.map(async (item) => {
      if (hasPriorFormulaChange(item, subscriptionsByContact.get(contactOf(item)) ?? [])) return true;
      const contactId = contactOf(item);
      const validFrom = item.validFrom?.slice(0, 10);
      if (!contactId || !validFrom) return false;
      const params = new URLSearchParams({
        contact: contactId,
        "order[validFrom]": "desc",
        itemsPerPage: "100",
        page: "1",
      });
      const payload = await api.getJson("/subscriptions", {
        endpoint: "subscriptions.byContact",
        params: Object.fromEntries(params),
      });
      return hasPriorFormulaChange(item, payload["hydra:member"] ?? []);
    }));
    const membershipSubscriptions = preEligibleMembershipSubscriptions.filter(
      (_item, index) => !fullPriorFormulaFlags[index],
    );
    // Un alta sin firmar cuenta como alta —la persona ya es socia—, pero puede
    // quedar invalidada si nadie la persigue, así que se anota aparte.
    const signatureIssueContacts = new Set();
    const signatureIssueStates = {};
    for (const item of membershipSubscriptions) {
      const label = signatureIssueLabel(item);
      if (!label) continue;
      const contact = contactOf(item);
      if (contact) signatureIssueContacts.add(contact);
      signatureIssueStates[label] = (signatureIssueStates[label] ?? 0) + 1;
    }
    const sessionSubscriptions = subscriptions.filter(isSession);
    const activeMemberSubscriptions = [];
    for (let pageNumber = 1; pageNumber <= 50; pageNumber += 1) {
      const params = new URLSearchParams({
        "contact.clubId": clubId,
        "terminatedAt[exists]": "false",
        "validFrom[before]": monthStart,
        "order[validFrom]": "desc",
        itemsPerPage: "100",
        page: String(pageNumber),
      });
      const payload = await api.getJson("/subscriptions", {
        endpoint: "subscriptions.active", params: Object.fromEntries(params),
      });
      const members = payload["hydra:member"] ?? [];
      activeMemberSubscriptions.push(...members);
      if (!payload["hydra:view"]?.["hydra:next"]) break;
    }
    const eligibleActiveSubscriptions = activeMemberSubscriptions.filter((item) => isEligibleActiveMember(item, {
      from: monthStart, to: today, enabledCodes: fitnessKpiEnabledProductCodes,
    }));
    const activeMembers = new Set(
      eligibleActiveSubscriptions.map(contactOf).filter(Boolean),
    ).size;
    // Un abono pendiente de pago sigue contando como socio activo: entra al
    // club. Se anota aparte para poder reclamar el cobro.
    const paymentIssueContacts = new Set();
    const paymentIssueStates = {};
    for (const item of eligibleActiveSubscriptions) {
      const label = paymentIssueLabel(item);
      if (!label) continue;
      const contact = contactOf(item);
      if (contact) paymentIssueContacts.add(contact);
      paymentIssueStates[label] = (paymentIssueStates[label] ?? 0) + 1;
    }
    const getCancellationSubscription = async (item) => {
      return api.getSubscription(item.subscription, { contact: item.contact ?? item.contactId });
    };
    const rawMonthlyCancellations = allCancellations.filter((item) => {
      const effectiveDate = item.cancellationDate?.slice(0, 10);
      return effectiveDate >= monthStart && effectiveDate <= today && item.status !== "canceled";
    });
    const rawCancellationSubscriptions = await Promise.all(
      rawMonthlyCancellations.map(getCancellationSubscription),
    );
    const monthlyCancellations = rawMonthlyCancellations.filter((item) => {
      const motiveName = motiveNames.get(item.cancellationMotiveId) ?? item.motive?.name ?? item.motiveName ?? item.motive;
      return normalizeState(item.status) !== "canceled" &&
        !normalizeText(motiveName).includes("cambio de formula");
    });
    const cancellationClassification = {
      rawEffectiveInPeriod: rawMonthlyCancellations.length,
      included: monthlyCancellations.length,
      excluded: {
        missingSubscription: 0,
        canceledOrVoided: 0,
        vip: 0,
        productNotEnabled: 0,
        formulaChange: 0,
        other: 0,
      },
    };
    rawMonthlyCancellations.forEach((item, index) => {
      const subscription = rawCancellationSubscriptions[index];
      const motiveName = motiveNames.get(item.cancellationMotiveId) ?? item.motive?.name ?? item.motiveName ?? item.motive;
      if (normalizeState(item.status) === "canceled") cancellationClassification.excluded.canceledOrVoided += 1;
      else if (normalizeText(motiveName).includes("cambio de formula")) {
        cancellationClassification.excluded.formulaChange += 1;
      } else if (!monthlyCancellations.includes(item)) cancellationClassification.excluded.other += 1;
    });
    const rawPendingCancellations = [];
    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      const params = new URLSearchParams({
        "contact.clubId": clubId,
        "cancellationDate[strictly_after]": today,
        "order[cancellationDate]": "asc",
        itemsPerPage: "100",
        page: String(pageNumber),
      });
      const payload = await api.getJson("/cancellations", {
        endpoint: "cancellations.pending", params: Object.fromEntries(params),
      });
      const members = payload["hydra:member"] ?? [];
      rawPendingCancellations.push(...members.filter((item) => normalizeState(item.status) !== "canceled"));
      if (!payload["hydra:view"]?.["hydra:next"]) break;
    }
    const pendingCancellationSubscriptions = await Promise.all(
      rawPendingCancellations.map(getCancellationSubscription),
    );
    const pendingCancellations = rawPendingCancellations.filter((item, index) => {
      const subscription = pendingCancellationSubscriptions[index];
      const motiveName = motiveNames.get(item.cancellationMotiveId) ?? item.motive?.name ?? item.motiveName ?? item.motive;
      return isEligibleCancellation(item, subscription, {
        from: today, to: "9999-12-31", enabledCodes: fitnessKpiEnabledProductCodes, motiveName,
      });
    });
    const nextPendingCancellationDate = pendingCancellations
      .map((item) => item.cancellationDate?.slice(0, 10))
      .filter(Boolean)
      .sort()[0] ?? null;
    const monthlyCancellationSubscriptionById = new Map(
      rawMonthlyCancellations.map((item, index) => [item["@id"], rawCancellationSubscriptions[index]]),
    );
    const cancellations = monthlyCancellations.filter(
      (item) => item.cancellationDate?.slice(0, 10) === today,
    );
    const technicalMonthlyMembershipContactIds = new Set(
      membershipSubscriptions.map((item) => item.contactId ?? item.contact?.["@id"]).filter(Boolean),
    );
    const nonDayPassUniqueMemberships = technicalMonthlyMembershipContactIds.size;
    const officialMemberships = fitnessKpiSnapshot?.period?.to === today
      ? fitnessKpiSnapshot.results?.[slug]
      : null;
    const fitnessKpiMonthlyMembershipContactIds = new Set(
      (officialMemberships?.memberIds ?? []).map((id) => `/onairespana/contacts/${id}`),
    );
    const monthlyMembershipContactIds = technicalMonthlyMembershipContactIds;
    const monthlyMembershipCheckpointContactIds = fitnessKpiMonthlyMembershipContactIds;
    const monthlyMembershipContactIdList = [...monthlyMembershipContactIds]
      .map((contactId) => String(contactId).split("/").at(-1))
      .filter(Boolean);
    const monthlyUniqueMemberships = monthlyMembershipContactIds.size;
    const monthlyMembershipOverlap = [...technicalMonthlyMembershipContactIds]
      .filter((id) => monthlyMembershipCheckpointContactIds.has(id)).length;
    const monthlyContacts = [];
    const monthlyClubContacts = [];
    for (let pageNumber = 1; pageNumber <= 50; pageNumber += 1) {
      const contactParams = new URLSearchParams({
        clubId,
        "order[createdAt]": "desc",
        isAnonymous: "false",
        itemsPerPage: "100",
        page: String(pageNumber),
      });
      const contactPayload = await api.getJson("/contacts", {
        endpoint: "contacts.list", params: Object.fromEntries(contactParams),
      });
      const members = contactPayload["hydra:member"] ?? [];
      const currentMonthContacts = members.filter((contact) =>
        contact.createdAt?.slice(0, 10) >= monthStart
      );
      monthlyContacts.push(...currentMonthContacts);
      monthlyClubContacts.push(...currentMonthContacts.filter((contact) => contact.channel === "club"));
      const oldest = members.at(-1)?.createdAt?.slice(0, 10);
      if (!contactPayload["hydra:view"]?.["hydra:next"] || (oldest && oldest < monthStart)) break;
    }
    const visitContactIds = new Set(monthlyClubContacts.map((contact) => contact["@id"]));
    const convertedVisitContactIds = new Set(
      monthlyClubContacts
        .filter((contact) => contact.state === "client" || monthlyMembershipContactIds.has(contact["@id"]))
        .map((contact) => contact["@id"]),
    );
    const visitConversionRate = visitContactIds.size
      ? Math.round((convertedVisitContactIds.size / visitContactIds.size) * 1000) / 10
      : 0;
    const tariffByContact = new Map();
    for (const subscription of membershipSubscriptions) {
      const contactId = subscription.contactId ?? subscription.contact?.["@id"];
      if (!contactId || tariffByContact.has(contactId)) continue;
      tariffByContact.set(
        contactId,
        String(subscription.name ?? subscription.initialInfo?.productName ?? "Tarifa sin identificar").trim(),
      );
    }
    const tariffTotals = new Map();
    for (const tariff of tariffByContact.values()) {
      tariffTotals.set(tariff, (tariffTotals.get(tariff) ?? 0) + 1);
    }
    const tariffSales = new Map();
    for (const [contactId, tariff] of tariffByContact.entries()) {
      if (!convertedVisitContactIds.has(contactId)) continue;
      tariffSales.set(tariff, (tariffSales.get(tariff) ?? 0) + 1);
    }
    const tariffConversion = [...tariffTotals.entries()]
      .map(([tariff, total]) => {
        const sales = tariffSales.get(tariff) ?? 0;
        return {
          tariff,
          sales,
          total,
          percentage: total
            ? Math.round((sales / total) * 1000) / 10
            : 0,
        };
      })
      .sort((a, b) => b.sales - a.sales || b.total - a.total || a.tariff.localeCompare(b.tariff, "es"));
    const conversionsWithoutTariff = Math.max(0, convertedVisitContactIds.size - [...tariffSales.values()].reduce((sum, count) => sum + count, 0));
    const contactDetailCache = new Map();
    const getContactDetail = async (contactId) => {
      if (!contactId) return null;
      if (!contactDetailCache.has(contactId)) {
        const id = contactId.split("/").at(-1);
        const detail = (await api.get(`/contacts/${id}`, {
          endpoint: "contacts.detail", allowStatuses: [404],
        })).data;
        contactDetailCache.set(contactId, detail ?? null);
      }
      return contactDetailCache.get(contactId);
    };
    const monthlyMembershipContacts = await Promise.all(
      monthlyMembershipContactIdList.map(async (contactId) => {
        const detail = await getContactDetail(`/onairespana/contacts/${contactId}`);
        return {
          contactId,
          firstname: detail?.firstname ?? detail?.firstName ?? null,
          lastname: detail?.lastname ?? detail?.lastName ?? null,
          email: detail?.email ?? null,
          phone: detail?.phone ?? null,
        };
      }),
    );
    const sourcesPayload = (await api.get("/referentials/sources", {
      endpoint: "referentials.sources", allowStatuses: [400, 403, 404],
    })).data ?? {};
    const sourceNames = new Map(
      (sourcesPayload["hydra:member"] ?? []).map((source) => [
        source["@id"],
        source.name ?? "Sin procedencia",
      ]),
    );
    const membershipSourceCounts = new Map();
    for (const contactId of monthlyMembershipContactIds) {
      const contact = await getContactDetail(contactId);
      const source = sourceNames.get(contact?.sourceId) ?? "Sin procedencia";
      membershipSourceCounts.set(source, (membershipSourceCounts.get(source) ?? 0) + 1);
    }
    const membershipSources = [...membershipSourceCounts.entries()]
      .map(([source, memberships]) => ({
        source,
        memberships,
        percentage: monthlyUniqueMemberships
          ? Math.round((memberships / monthlyUniqueMemberships) * 1000) / 10
          : 0,
      }))
      .sort((a, b) => b.memberships - a.memberships || a.source.localeCompare(b.source, "es"));
    const isReceptionSource = (value) =>
      /recepci[oó]n del club|visita al club|club reception|reception/.test(normalizeText(value));
    const isSpontaneousMembershipSubscription = (subscription) => {
      if (!subscription || isSession(subscription) || isShortPass(subscription) || isVip(subscription) || isWebOffer(subscription)) return false;
      const label = normalizeText(subscription?.name ?? subscription?.initialInfo?.productName ?? "");
      const code = productCode(subscription);
      return label.includes("bono 1 mes") ||
        label.includes("abono 1 mes") ||
        label.includes("on air") ||
        isCdd(subscription) ||
        fitnessKpiEnabledProductCodes.has(code);
    };
    const spontaneousMembershipContactIds = new Set();
    for (const contactId of monthlyMembershipContactIds) {
      const contact = await getContactDetail(contactId);
      const source = sourceNames.get(contact?.sourceId) ?? contact?.source ?? "Sin procedencia";
      if (!isReceptionSource(source)) continue;
      const contactSubscriptions = subscriptionsByContact.get(contactId) ?? [];
      if (contactSubscriptions.some(isSpontaneousMembershipSubscription)) {
        spontaneousMembershipContactIds.add(contactId);
      }
    }
    const attributedVisitMembershipContactIds = new Set(
      [...convertedVisitContactIds].filter((contactId) => !spontaneousMembershipContactIds.has(contactId)),
    );
    const spontaneousSales = spontaneousMembershipContactIds.size;
    const attributedVisitSales = attributedVisitMembershipContactIds.size;
    const overlapVisitAndSpontaneous = convertedVisitContactIds.size - attributedVisitSales;
    const sessionClassifications = sessionSubscriptions.map((subscription) => {
      const contactId = subscription.contactId ?? subscription.contact?.["@id"];
      return {
        subscription,
        contactId,
        isTie: isTieSession(subscription),
        isDayPass: isDayPassSession(subscription),
      };
    });
    const tieSessions = sessionClassifications.filter((row) => row.isTie);
    const dayPassSessions = sessionClassifications.filter((row) => row.isDayPass);
    const unclassifiedSessions = sessionClassifications.filter((row) => !row.isTie && !row.isDayPass);
    const tieCustomers = new Set(tieSessions.map((row) => row.contactId).filter(Boolean)).size;
    const dayPassCustomers = new Set(dayPassSessions.map((row) => row.contactId).filter(Boolean)).size;
    const dayPassCounts = new Map();
    for (const row of dayPassSessions) {
      if (row.contactId) dayPassCounts.set(row.contactId, (dayPassCounts.get(row.contactId) ?? 0) + 1);
    }
    const repeatDayPassCustomers = [...dayPassCounts.values()].filter((count) => count > 1).length;
    const tenDaysAgo = new Date(`${today}T23:59:59+02:00`);
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    let earlyReferrers = 0;
    let earlyReferrals = 0;
    for (const contact of monthlyContacts.filter((item) => item.state === "client")) {
      const detail = await getContactDetail(contact["@id"]);
      if (!detail) continue;
      const clientSince = new Date(detail.registeredAt ?? detail.createdAt);
      const sponsored = detail.activeSponsoredContacts ?? [];
      if (clientSince >= tenDaysAgo && sponsored.length > 0) {
        earlyReferrers += 1;
        earlyReferrals += sponsored.length;
      }
    }
    const dailySubscriptions = membershipSubscriptions.filter(
      (item) => item.validFrom?.slice(0, 10) === today,
    );
    const technicalDailyMembershipContactIds = new Set(
      dailySubscriptions
        .map((item) => item.contactId ?? item.contact?.["@id"])
        .filter(Boolean),
    );
    const technicalDailyMemberships = technicalDailyMembershipContactIds.size;
    const fitnessKpiDailyMembershipContactIds = new Set(
      (officialMemberships?.memberIdsToday ?? []).map((id) => `/onairespana/contacts/${id}`),
    );
    const dailyMembershipContactIds = technicalDailyMembershipContactIds;
    const dailyMembershipCheckpointContactIds = fitnessKpiDailyMembershipContactIds;
    const dailyMembershipContactIdList = [...dailyMembershipContactIds]
      .map((contactId) => String(contactId).split("/").at(-1))
      .filter(Boolean);
    const uniqueMemberships = dailyMembershipContactIds.size;
    const dailyMembershipOverlap = [...technicalDailyMembershipContactIds]
      .filter((id) => dailyMembershipCheckpointContactIds.has(id)).length;

    const payments = [];
    for (let pageNumber = 1; pageNumber <= 50; pageNumber += 1) {
      const paymentParams = new URLSearchParams({
        clubId,
        "order[id]": "desc",
        itemsPerPage: "100",
        page: String(pageNumber),
      });
      const paymentPayload = await api.getJson("/payments", {
        endpoint: "payments.list", params: Object.fromEntries(paymentParams),
      });
      const members = paymentPayload["hydra:member"] ?? [];
      payments.push(
        ...members.filter(
          (item) =>
            item.createdAt?.slice(0, 10) === today &&
            normalizeState(item.financialState) === "validated" &&
            !item.canceledAt,
        ),
      );
      const oldest = members.at(-1)?.createdAt?.slice(0, 10);
      if (!paymentPayload["hydra:view"]?.["hydra:next"] || (oldest && oldest < today)) break;
    }
    const revenue = payments.reduce((sum, item) => sum + Number(item.amount ?? 0), 0) / 100;
    const monthlyInvoices = [];
    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      const invoiceParams = new URLSearchParams({
        clubId,
        "order[createdAt]": "desc",
        itemsPerPage: "100",
        page: String(pageNumber),
      });
      const invoicePayload = await api.getJson("/invoices", {
        endpoint: "invoices.list", params: Object.fromEntries(invoiceParams),
      });
      const members = invoicePayload["hydra:member"] ?? [];
      monthlyInvoices.push(...members.filter((item) => isValidInvoice(item, { from: monthStart })));
      const oldest = members.at(-1)?.createdAt?.slice(0, 10);
      if (!invoicePayload["hydra:view"]?.["hydra:next"] || (oldest && oldest < monthStart)) break;
    }
    const billing = monthlyInvoices
      .filter((item) => item.createdAt?.slice(0, 10) === today)
      .reduce((sum, item) => sum + Number(item.totalTI ?? 0), 0) / 100;
    const monthlyBilling = monthlyInvoices.reduce(
      (sum, item) => sum + Number(item.totalTI ?? 0), 0
    ) / 100;
    const monthlyInvoiceLines = monthlyInvoices.flatMap((invoice) => invoice.lines ?? [])
      .filter((line) => !line.deletedAt);
    const monthlyMerch = monthlyInvoiceLines
      .filter((line) => line.code === "MERCH")
      .reduce((sum, line) => sum + Number(line.priceTI ?? 0), 0) / 100;
    const monthlySupplements = monthlyInvoiceLines
      .filter((line) => line.code === "PROT")
      .reduce((sum, line) => sum + Number(line.priceTI ?? 0), 0) / 100;
    const blockingReasonsPayload = (await api.get("/referentials/blocking_reasons", {
      endpoint: "referentials.blockingReasons", allowStatuses: [400, 403, 404],
    })).data ?? {};
    const incompleteReasonIds = new Set(
      (blockingReasonsPayload["hydra:member"] ?? [])
        .filter((reason) => {
          const label = String(reason.name ?? reason.label ?? reason.wording ?? "")
            .toLocaleLowerCase("es");
          return /falta|incomplet|no firmado|manquant|nécessaire|à générer|documento.*comprobar|documentos.*comprobar|autorización/.test(label) &&
            !/devolver|caducad/.test(label);
        })
        .map((reason) => reason["@id"]),
    );
    const incompleteContacts = new Set();
    for (let pageNumber = 1; pageNumber <= 50; pageNumber += 1) {
      const alertParams = new URLSearchParams({
        clubId,
        "order[id]": "desc",
        itemsPerPage: "100",
        page: String(pageNumber),
      });
      const alertPayload = await api.getJson("/alerts", {
        endpoint: "alerts.list", params: Object.fromEntries(alertParams),
      });
      const members = alertPayload["hydra:member"] ?? [];
      for (const alert of members) {
        const contactId = alert.contact?.["@id"] ?? alert.contactId;
        if (
          !alert.archivedAt &&
          incompleteReasonIds.has(alert.blockingReasonId) &&
          monthlyMembershipContactIds.has(contactId)
        ) incompleteContacts.add(contactId);
      }
      const oldestAlert = members.at(-1)?.createdAt?.slice(0, 10);
      if (!alertPayload["hydra:view"]?.["hydra:next"] || (oldestAlert && oldestAlert < monthStart)) break;
    }
    const fullPeriodCancellations = rawMonthlyCancellations.filter(
      (item) => isShortNoticeFullPeriodCancellation(item),
    ).length;
    const validMonthlyCancellations = monthlyCancellations.filter((item) => item.status !== "canceled");
    const cancellationSubscriptions = validMonthlyCancellations.map(
      (item) => monthlyCancellationSubscriptionById.get(item["@id"]) ?? null,
    );
    const oneMonthCancellations = cancellationSubscriptions.filter((subscription) => {
      const code = String(subscription?.initialInfo?.productCode ?? "").toLocaleLowerCase("es");
      const label = String(subscription?.name ?? subscription?.initialInfo?.productName ?? "")
        .toLocaleLowerCase("es");
      return code === "cdd2" || label.includes("abono 1 mes");
    }).length;
    const automaticCancellations = validMonthlyCancellations.filter((item) =>
      /traitement automatique|consumer/i.test(item.createdBy ?? "")
    );
    let automaticReturnFeeOnly = 0;
    for (const cancellation of automaticCancellations) {
      const contactId = cancellation.contact?.["@id"];
      if (!contactId) continue;
      const invoiceParams = new URLSearchParams({
        contactId,
        "order[createdAt]": "desc",
        page: "1",
      });
      let invoicePayload;
      try {
        invoicePayload = await api.getJson("/invoices", {
          endpoint: "invoices.byContact", params: Object.fromEntries(invoiceParams),
        });
      } catch { continue; }
      const outstanding = (invoicePayload["hydra:member"] ?? []).filter((invoice) =>
        !invoice.canceledAt && !invoice.deletedAt &&
        Number(invoice.totalTI ?? 0) - Number(invoice.totalPaid ?? 0) > 0
      );
      if (outstanding.length > 0 && outstanding.every((invoice) => invoice.rejectionFee === true)) {
        automaticReturnFeeOnly += 1;
      }
    }
    return {
      slug,
      name,
      id,
      ok: true,
      collectedAt: new Date().toISOString(),
      period: today,
      cancellations: cancellations.length,
      memberships: uniqueMemberships,
      revenue,
      billing,
      refunds: null,
      apiMetrics: api.snapshotMetrics(),
      monthToDate: {
        memberships: monthlyUniqueMemberships,
        members: officialMemberships?.members != null
          ? officialMemberships.members + uniqueMemberships - cancellations.length
          : activeMembers,
        membershipSources,
        cancellations: monthlyCancellations.length,
        cancellationClassification,
        activeNet: monthlyUniqueMemberships - monthlyCancellations.length,
        merch: monthlyMerch,
        supplements: monthlySupplements,
        ties: tieSessions.length,
        tieCustomers,
        dayPasses: dayPassSessions.length,
        dayPassCustomers,
        membershipClassification: {
          rule: "fitnesskpi-validFrom-enabled-no-vip-cdd-prior-formula-v1",
          enabledProductCodes: [...fitnessKpiEnabledProductCodes],
          cddAlwaysIncluded: true,
          vipExcluded: true,
          webOffersExcluded: false,
          priorFormulaChangeExcluded: true,
          source: officialMemberships
            ? "Resamania live qualified subscriptions with FitnessKPI checkpoint"
            : "Resamania classified subscriptions",
          fitnessKpiMonthlyCount: fitnessKpiMonthlyMembershipContactIds.size,
          fitnessKpiDailyCount: fitnessKpiDailyMembershipContactIds.size,
          technicalMonthlyCount: nonDayPassUniqueMemberships,
          technicalDailyCount: technicalDailyMemberships,
          monthlyOverlap: monthlyMembershipOverlap,
          dailyOverlap: dailyMembershipOverlap,
          combinedMonthlyCount: monthlyUniqueMemberships,
          combinedDailyCount: uniqueMemberships,
          checkpointMonthlyCount: fitnessKpiMonthlyMembershipContactIds.size,
          checkpointDailyCount: fitnessKpiDailyMembershipContactIds.size,
          membershipContactIds: monthlyMembershipContactIdList,
          dailyMembershipContactIds: dailyMembershipContactIdList,
          checkpointMembershipContactIds: [...monthlyMembershipCheckpointContactIds]
            .map((contactId) => String(contactId).split("/").at(-1))
            .filter(Boolean),
          checkpointDailyMembershipContactIds: [...dailyMembershipCheckpointContactIds]
            .map((contactId) => String(contactId).split("/").at(-1))
            .filter(Boolean),
          nonDayPassUniqueContacts: nonDayPassUniqueMemberships,
          tieSubscriptions: tieSessions.length,
          dayPassSubscriptions: dayPassSessions.length,
          unclassifiedSessions: unclassifiedSessions.length,
          monthlyMembershipContacts,
        },
        activeMemberClassification: {
          rule: officialMemberships?.members != null
            ? "fitnesskpi-previous-close-plus-resamania-today-net"
            : "started-before-period-active-through-period-enabled-no-vip-v2",
          source: officialMemberships?.members != null
            ? "FitnessKPI previous close + Resamania live qualified movements"
            : "Resamania calculated subscriptions fallback",
          fitnessKpiCount: officialMemberships?.members ?? null,
          checkpointThrough: fitnessKpiSnapshot?.period?.checkpointThrough ?? null,
          resamaniaMembershipsToday: uniqueMemberships,
          resamaniaCancellationsToday: cancellations.length,
          liveNetChange: uniqueMemberships - cancellations.length,
          resamaniaCalculatedCount: activeMembers,
          enabledProductCodes: [...fitnessKpiEnabledProductCodes],
          vipExcluded: true,
          webOffersExcluded: false,
          sessionsExcluded: true,
        },
        commercialIndicators: {
          repeatDayPassCustomers,
          earlyReferrers,
          earlyReferrals,
        },
        formulaChanges: rawMonthlyCancellations.filter((item) =>
          String(
            motiveNames.get(item.cancellationMotiveId) ??
              item.motive?.name ??
              item.motiveName ??
              item.motive ??
              "",
          )
            .toLocaleLowerCase("es")
            .includes("cambio de fórmula"),
        ).length,
        billing: monthlyBilling,
        // Censo de estados en bruto: sólo etiquetas y recuentos, sin datos de
        // nadie. Es lo que permite ver si una regla se está quedando corta.
        stateCensus: {
          subscriptions: tallyStates(subscriptionHistory),
          invoices: tallyStates(monthlyInvoices),
          cancellations: tallyStates(allCancellations),
        },
        incidences: {
          incompleteMemberships: incompleteContacts.size,
          fullPeriodCancellations,
          oneMonthCancellations,
          automaticReturnFeeOnly,
          pendingCancellations: pendingCancellations.length,
          nextPendingCancellationDate,
          paymentIncidences: paymentIssueContacts.size,
          paymentIncidenceStates: paymentIssueStates,
          signatureIncidences: signatureIssueContacts.size,
          signatureIncidenceStates: signatureIssueStates,
        },
        salesFunnel: {
          visits: visitContactIds.size,
          resamaniaClubContacts: visitContactIds.size,
          resamaniaConvertedClubContacts: attributedVisitSales,
          conversions: attributedVisitSales,
          conversionRate: visitConversionRate,
          tariffConversion,
          conversionsWithoutTariff,
          attributedVisitSales,
          attributedVisitContactIds: [...attributedVisitMembershipContactIds]
            .map((contactId) => String(contactId).split("/").at(-1))
            .filter(Boolean),
          spontaneousContactIds: [...spontaneousMembershipContactIds]
            .map((contactId) => String(contactId).split("/").at(-1))
            .filter(Boolean),
          overlapVisitAndSpontaneous,
          spontaneousSales,
          spontaneousSourceLabel: "Recepción del club",
          source: "contacts.channel=club",
        },
      },
    };
  } catch (error) {
    return {
      slug, name, id, ok: false, error: error.message, period: today,
      authFailed: error.authFailed === true,
      apiMetrics: api?.snapshotMetrics() ?? null,
    };
  } finally {
    if (api) await api.flushCache().catch(() => {});
    if (context) {
      await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 4000))]);
    }
  }
}

const requestedSlug = process.argv[2];
const clubsToCollect = requestedSlug
  ? clubs.filter(([slug]) => slug === requestedSlug)
  : clubs;
if (requestedSlug && clubsToCollect.length === 0) throw new Error(`Club desconocido: ${requestedSlug}`);
let previousResults = [];
try {
  previousResults = JSON.parse(
    await readFile(`${artifactsDir}/dashboard-live.json`, "utf8"),
  ).results ?? [];
} catch {}
const attemptedResults = [];
async function persistProgress() {
  const attemptedBySlug = new Map(attemptedResults.map((attempt) => [attempt.slug, attempt]));
  const previousBySlug = new Map(previousResults.map((result) => [result.slug, result]));
  const results = clubs.map(([slug, name, id]) => {
    const attempt = attemptedBySlug.get(slug);
    const previous = previousBySlug.get(slug);
    if (!attempt) return previous ?? { slug, name, id, ok: false, error: "Sin captura" };
    if (attempt.ok) return attempt;
    // Conservar la última captura buena es correcto, pero presentarla sin
    // marcar equivale a enseñar datos viejos con hora nueva. Se etiqueta.
    return previous?.ok
      ? {
          ...previous,
          stale: true,
          staleSince: previous.collectedAt ?? previous.period ?? null,
          lastError: attempt.error,
          lastAuthFailed: attempt.authFailed === true,
        }
      : attempt;
  });
  const output = { generatedAt: new Date().toISOString(), period: today, results };
  await writeFile(`${artifactsDir}/dashboard-live.json`, JSON.stringify(output, null, 2), "utf8");
  previousResults = results;
}
let sessionExpired = false;
for (const club of clubsToCollect) {
  const result = await collect(club);
  attemptedResults.push(result);
  await persistProgress();
  // Si la sesión ha caducado fallará igual en los seis centros restantes:
  // seguir sólo alarga la pasada y ensucia el snapshot con datos marcados.
  if (result.authFailed) {
    sessionExpired = true;
    break;
  }
}
console.log(JSON.stringify(attemptedResults, null, 2));
if (sessionExpired) {
  const pending = clubsToCollect
    .filter(([slug]) => !attemptedResults.some((result) => result.slug === slug))
    .map(([, clubName]) => clubName);
  console.error(`\n${attemptedResults.at(-1).error}`);
  if (pending.length > 0) console.error(`Centros sin recoger en esta pasada: ${pending.join(", ")}.`);
}
process.exit(attemptedResults.every((result) => result.ok) ? 0 : 1);
