import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const profileDir = process.env.LEAD_PROFILE_DIR ?? `${rootDir}/.lead-profile`;
const clubs = [
  { slug: "ruzafa", id: 13125, name: "Valencia Ruzafa" },
  { slug: "nuevo-centro", id: 13490, name: "Valencia Nuevo Centro" },
  { slug: "les-arts", id: 13886, name: "Valencia Les Arts" },
  { slug: "madrid", id: 14179, name: "Madrid Delicias" },
];
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const monthStart = `${today.slice(0, 8)}01`;
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome", headless: true,
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`https://lead.masalledesport.com/club/${clubs[0].id}/statistics`, {
    waitUntil: "domcontentloaded", timeout: 90000,
  });
  const results = [];
  for (const club of clubs) {
    const base = `clubId=${club.id}&startDate=${monthStart}&endDate=${today}&format=total&ignoreArchived=true`;
    const paths = {
      leads: `/api/stats/leads?${base}`,
      appointments: `/api/stats/appointments?${base}`,
      attendedAppointments: `/api/stats/appointments?${base}&presence=done`,
      unattendedAppointments: `/api/stats/appointments?${base}&presence=notDone`,
      conversionRate: `/api/stats/transformationRate?${base}`,
      cohortSales: `/api/stats/subscribersOnNewProspects?clubId=${club.id}&startDate=${monthStart}&endDate=${today}&ignoreArchived=true&compareTo=previousYear`,
      sales: `/api/stats/sales?${base}`,
      visits: `/api/stats/clubVisitsByCommercial?${base}&compareTo=previousYear`,
    };
    const values = await page.evaluate(async (entries) => Object.fromEntries(await Promise.all(
      entries.map(async ([key, path]) => {
        const response = await fetch(path, { credentials: "include" });
        if (!response.ok) throw new Error(`${key}: HTTP ${response.status}`);
        const payload = await response.json();
        return [key, key === "cohortSales" ? payload.data?.[0]?.value ?? null : payload.total];
      })),
    ), Object.entries(paths));
    const leadJourney = await page.evaluate(async ({ placeId, monthStart, today }) => {
      const from = new Date(`${monthStart}T00:00:00+02:00`).getTime();
      const through = new Date(`${today}T23:59:59+02:00`).getTime();
      const rows = [];
      for (const status of ["TRIAL_HONORED", "OLD_CLIENT", "OLD_NETWORK_CLIENT"]) {
        for (let pageNumber = 1; pageNumber <= 30; pageNumber += 1) {
          const params = new URLSearchParams({
            search: "", status, page: String(pageNumber), resultPerPage: "100",
            placeId: String(placeId), orderBy: "activities_last_date", orderType: "desc",
            withActivityCount: "true",
          });
          const response = await fetch(`/api/lead/lead?${params}`, { credentials: "include" });
          if (!response.ok) throw new Error(`${status}: HTTP ${response.status}`);
          const payload = await response.json();
          const values = payload.values ?? [];
          rows.push(...values.filter((lead) => {
            const statusDate = lead.status_date ?? 0;
            return status === "TRIAL_HONORED" || (statusDate >= from && statusDate <= through);
          }).map((lead) => ({
            contactId: String(lead.partner_sync_id ?? "").split("/").at(-1),
            source: lead.source,
            status: lead.status,
            firstname: lead.firstname,
            lastname: lead.lastname,
            email: lead.email,
            phone: lead.phone,
            createdAt: lead.creation?.date ?? null,
            statusDate: lead.status_date ?? null,
          })));
          const oldest = values.at(-1)?.activities_last?.date ?? values.at(-1)?.status_date ?? values.at(-1)?.creation?.date;
          const shouldStop = status !== "TRIAL_HONORED";
          if (!values.length || pageNumber >= (payload.pagination?.maxPage ?? 0) || (shouldStop && oldest && oldest < from)) break;
        }
      }
      return rows.filter((lead) => lead.contactId);
    }, { placeId: club.id, monthStart, today });
    const honoredLeadsByContact = new Map();
    for (const lead of leadJourney.filter((item) => item.status === "TRIAL_HONORED")) {
      const current = honoredLeadsByContact.get(lead.contactId);
      if (!current || (lead.statusDate ?? 0) > (current.statusDate ?? 0)) honoredLeadsByContact.set(lead.contactId, lead);
    }
    const convertedLeadsByContact = new Map();
    for (const lead of leadJourney.filter((item) => ["OLD_CLIENT", "OLD_NETWORK_CLIENT"].includes(item.status))) {
      const current = convertedLeadsByContact.get(lead.contactId);
      if (!current || (lead.statusDate ?? 0) > (current.statusDate ?? 0)) convertedLeadsByContact.set(lead.contactId, lead);
    }
    const attributedSales = [...convertedLeadsByContact.values()]
      .map((converted) => {
        const honored = honoredLeadsByContact.get(converted.contactId) ?? null;
        const type = honored?.source === "CLUB_RECEPTION" ? "spontaneous" : "visit";
        return {
          contactId: converted.contactId,
          firstname: converted.firstname,
          lastname: converted.lastname,
          email: converted.email,
          phone: converted.phone,
          source: honored?.source ?? converted.source,
          convertedAt: converted.statusDate,
          status: converted.status,
          type,
        };
      })
      .filter((lead) => lead.convertedAt !== null)
      .sort((a, b) => (b.convertedAt ?? 0) - (a.convertedAt ?? 0));
    const attributedVisitSales = attributedSales.filter((lead) => lead.type === "visit").length;
    const attributedSpontaneousSales = attributedSales.filter((lead) => lead.type === "spontaneous").length;
    results.push({
      ...club, ok: true,
      salesFunnel: {
        leads: values.leads,
        appointments: values.appointments,
        attendedAppointments: values.attendedAppointments,
        unattendedAppointments: values.unattendedAppointments,
        otherAppointments: Math.max(
          0,
          values.appointments - values.attendedAppointments - values.unattendedAppointments,
        ),
        visits: values.visits,
        spontaneousVisits: Math.max(0, values.visits - values.attendedAppointments),
        sales: values.sales,
        cohortSales: values.cohortSales,
        attributedVisitSales,
        attributedSpontaneousSales,
        attributedSales,
        spontaneousToSaleRate: values.visits - values.attendedAppointments > 0
          ? Math.round((attributedSpontaneousSales / (values.visits - values.attendedAppointments)) * 1000) / 10
          : 0,
        conversions: values.sales,
        conversionRate: values.conversionRate,
        leadToAppointmentRate: values.leads
          ? Math.round((values.appointments / values.leads) * 1000) / 10 : 0,
        appointmentToVisitRate: values.appointments
          ? Math.round((values.attendedAppointments / values.appointments) * 1000) / 10 : 0,
        leadToSaleRate: values.leads
          ? Math.round((values.cohortSales / values.leads) * 1000) / 10 : 0,
        visitToSaleRate: values.visits
          ? Math.round((values.sales / values.visits) * 1000) / 10
          : 0,
        source: "Lead 2.0 official statistics",
        updateFrequencyMinutes: 30,
      },
    });
  }
  const output = { generatedAt: new Date().toISOString(), period: { from: monthStart, to: today }, results };
  await writeFile(`${rootDir}/artifacts/lead-live.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
} finally {
  await context.close();
}
