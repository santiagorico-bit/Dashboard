const fmtNumber = new Intl.NumberFormat("es-ES");
const fmtCurrency = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
let dashboard;

function value(value, formatter = fmtNumber) {
  return value === null || value === undefined ? "—" : formatter.format(value);
}

function statusLabel(status) {
  return status === "live" ? "Tiempo real" : status === "stale" ? "Histórico" : "Sin conectar";
}

function escapeAttribute(text) {
  return String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * El banco de arriba avisa de la sesión caducada. Sin esto, un centro que
 * reutiliza su última captura buena se veía igual que uno recogido hoy.
 */
function renderBanner(clubs) {
  const banner = document.querySelector("#banner");
  const expired = clubs.filter((club) => club.authFailed);
  const stale = clubs.filter((club) => club.freshness === "stale" && club.lastError);
  banner.classList.toggle("banner-alert", expired.length > 0);

  let body;
  if (expired.length > 0) {
    const names = expired.map((club) => club.name).join(", ");
    body = `<strong>Sesión de Resamania caducada</strong><p>${names} ${expired.length === 1 ? "muestra su última captura válida" : "muestran su última captura válida"}, no los datos de hoy. Ejecuta <code>npm run setup:club</code> y vuelve a lanzar <code>npm run collect:dashboard</code>.</p>`;
  } else if (stale.length > 0) {
    body = `<strong>Captura incompleta</strong><p>${stale.length} ${stale.length === 1 ? "centro conserva" : "centros conservan"} la lectura anterior porque la última pasada falló. Pasa el ratón por su estado para ver el motivo.</p>`;
  } else {
    body = `<strong>Conectando fuentes por centro</strong><p>La interfaz está lista. Las métricas no conectadas se muestran como “—”, nunca como ceros.</p>`;
  }

  banner.innerHTML = `<div class="banner-icon">!</div><div>${body}</div><span id="connection-count"></span>`;
}

/**
 * Detalle de los estados que han provocado una incidencia. Saber si es un
 * recibo devuelto o un cobro sin lanzar cambia a quién hay que llamar.
 */
function stateDetail(states) {
  const entries = Object.entries(states ?? {});
  if (entries.length === 0) return "Sin incidencias";
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([state, count]) => `${state}: ${count}`)
    .join(" · ");
}

function objectiveMetric(label, actual, target, percentage, kind, detail = "") {
  const width = percentage === null ? 0 : Math.max(0, Math.min(100, percentage));
  return `<div class="objective-metric ${kind}"><span class="objective-label">${label}</span><div class="objective-values"><strong>${value(actual)}</strong><span>de ${value(target)}</span></div>${detail ? `<small>${detail}</small>` : ""}<span class="objective-percent">${percentage === null ? "—" : `${fmtNumber.format(percentage)}%`}</span><div class="objective-track"><i style="width:${width}%"></i></div></div>`;
}

function factualMetric(label, displayValue, detail, kind) {
  return `<div class="objective-metric ${kind}"><span class="objective-label">${label}</span><div class="objective-values"><strong>${displayValue}</strong><span>${detail}</span></div><div class="objective-track"><i style="width:100%"></i></div></div>`;
}

function tariffConversionMetric(funnel, totalMemberships) {
  if (!funnel || !Array.isArray(funnel.tariffConversion)) {
    return `<div class="objective-metric tariffConversion"><span class="objective-label">Altas por tarifa</span><div class="objective-values"><strong>—</strong><span>Pendiente de actualización</span></div></div>`;
  }
  const tariffs = funnel?.tariffConversion ?? [];
  const tariffRowText = (row) => {
    const sales = Number.isFinite(row.sales) ? row.sales : row.conversions;
    const percentage = Number.isFinite(totalMemberships) && Number.isFinite(sales) && totalMemberships > 0
      ? Math.round((sales / totalMemberships) * 1000) / 10
      : null;
    return `<li><span>${row.tariff}</span><strong>${percentage == null ? "—" : `${fmtNumber.format(percentage)}%`}</strong><small>${value(sales)} altas de ${value(totalMemberships)}</small></li>`;
  };
  const rows = tariffs.length
    ? tariffs.map((row) => tariffRowText(row)).join("")
    : `<li><span>Sin altas con tarifa</span><strong>—</strong></li>`;
  const missing = funnel?.conversionsWithoutTariff
    ? `<li class="unclassified"><span>Sin tarifa identificada</span><strong>—</strong><small>${value(funnel.conversionsWithoutTariff)} altas</small></li>`
    : "";
  return `<div class="objective-metric tariffConversion"><span class="objective-label">Altas por tarifa</span><ul class="tariff-conversion-list">${rows}${missing}</ul></div>`;
}

function membershipSourcesMetric(actual) {
  if (!actual || !Array.isArray(actual.membershipSources)) {
    return `<div class="objective-metric membershipSources"><span class="objective-label">Altas por procedencia</span><div class="objective-values"><strong>—</strong><span>Pendiente de actualización</span></div></div>`;
  }
  const rows = actual.membershipSources.length
    ? actual.membershipSources.map((row) => `<li><span>${row.source}</span><strong>${fmtNumber.format(row.percentage)}%</strong><small>${value(row.memberships)}</small></li>`).join("")
    : `<li><span>Sin altas este mes</span><strong>—</strong></li>`;
  return `<div class="objective-metric membershipSources"><span class="objective-label">Altas por procedencia</span><ul class="tariff-conversion-list">${rows}</ul></div>`;
}

function spontaneousSalesFromClub(club) {
  const sources = club?.monthToDate?.membershipSources;
  if (!Array.isArray(sources)) return null;
  const total = sources
    .filter((source) => /recepci[oó]n del club|club reception|reception/i.test(String(source?.source ?? "")))
    .reduce((sum, source) => sum + Number(source?.memberships ?? 0), 0);
  return Number.isFinite(total) ? total : null;
}

function visitFunnelMetrics(club) {
  const lead = club?.leadFunnel ?? {};
  const resamania = club?.salesFunnel ?? {};
  if (!lead && !resamania) return factualMetric("Embudo de visitas", "—", "Pendiente de conexión", "visits");
  const attributedVisitSales = Number.isFinite(lead.attributedVisitSalesRaw)
    ? lead.attributedVisitSalesRaw
    : Number.isFinite(lead.attributedVisitSalesMatched)
      ? lead.attributedVisitSalesMatched
      : Number.isFinite(lead.attributedVisitSales)
        ? lead.attributedVisitSales
        : Number.isFinite(resamania.conversions)
          ? resamania.conversions
          : null;
  const totalMemberships = Number.isFinite(club?.monthToDate?.memberships)
    ? club.monthToDate.memberships
    : null;
  const attributedVisitSalesGap = Number.isFinite(lead.attributedVisitSalesGap)
    ? lead.attributedVisitSalesGap
    : null;
  const attendedToSale = attributedVisitSales == null || !lead.attendedAppointments
    ? null
    : Math.round((attributedVisitSales / lead.attendedAppointments) * 1000) / 10;
  const attributedSalesVisible = Array.isArray(lead.attributedSales) && attributedVisitSales != null
    ? lead.attributedSales
      .filter((lead) => lead.type === "visit")
      .slice(0, Math.min(lead.attributedSales.length, attributedVisitSales))
    : Array.isArray(lead.attributedSales)
      ? lead.attributedSales
      : [];
  const attributedSalesList = attributedSalesVisible.length
    ? `<details class="attributed-sales"><summary>Altas por visita verificadas <strong>${value(attributedVisitSales)}</strong></summary><ul>${attributedSalesVisible.map((lead) => {
        const type = lead.type === "spontaneous" ? "Espontánea" : "Visita";
        const convertedAt = lead.convertedAt ? new Date(lead.convertedAt).toLocaleDateString("es-ES") : "—";
        const name = [lead.firstname, lead.lastname].filter(Boolean).join(" ").trim() || "Sin nombre";
        return `<li><span>${name}</span><small>${type} · ${convertedAt}</small><b>${lead.source ?? "Sin origen"}</b></li>`;
      }).join("")}${attributedVisitSalesGap != null && attributedVisitSalesGap > 0 ? `<li class="attributed-gap"><span>${value(attributedVisitSalesGap)} alta(s) sin cruce con visita realizada</span><small>Revisar cruce</small></li>` : ""}</ul></details>`
    : "";
  const spontaneousSales = Number.isFinite(resamania.spontaneousSales)
    ? resamania.spontaneousSales
    : spontaneousSalesFromClub(club) ?? 0;
  const leadToSaleRate = Number.isFinite(lead.leads) && attributedVisitSales != null
    ? Math.round((attributedVisitSales / lead.leads) * 1000) / 10
    : lead.leadToSaleRate;
  const balanceSales = totalMemberships == null || attributedVisitSales == null
    ? null
    : totalMemberships - attributedVisitSales - spontaneousSales;
  const leadFunnelGraphic = `<section class="visit-funnel visit-funnel-main"><div class="visit-funnel-title"><span>Embudo principal</span></div><div class="funnel-stages"><div class="funnel-stage stage-lead"><small>Lead generado</small><strong>${value(lead.leads)}</strong></div><div class="funnel-rate"><b>${value(lead.leadToAppointmentRate)}%</b><span>Lead → cita</span></div><div class="funnel-stage stage-booked"><small>Visita agendada</small><strong>${value(lead.appointments)}</strong></div><div class="funnel-rate"><b>${value(lead.appointmentToVisitRate)}%</b><span>Cita → realizada</span></div><div class="funnel-stage stage-visit"><small>Visita realizada</small><strong>${value(lead.attendedAppointments)}</strong></div><div class="funnel-rate ${attendedToSale == null ? "pending" : ""}"><b>${attendedToSale == null ? "—" : `${value(attendedToSale)}%`}</b><span>Realizada → alta</span></div><div class="funnel-stage stage-sale"><small>Alta por visita</small><strong>${value(attributedVisitSales)}</strong></div></div><div class="funnel-total"><span>Conversión total</span><strong>${value(leadToSaleRate)}%</strong></div></section>`;
  const spontaneousRateValue = lead.spontaneousVisits
    ? Math.round((spontaneousSales / lead.spontaneousVisits) * 1000) / 10
    : null;
  const spontaneousFunnelGraphic = `<section class="visit-funnel visit-funnel-spontaneous"><div class="visit-funnel-title"><span>Embudo espontáneo</span></div><div class="funnel-stages"><div class="funnel-stage stage-lead"><small>Visitas espontáneas</small><strong>${value(lead.spontaneousVisits)}</strong></div><div class="funnel-rate ${spontaneousRateValue == null ? "pending" : ""}"><b>${spontaneousRateValue == null ? "—" : `${value(spontaneousRateValue)}%`}</b><span>Visita → alta</span></div><div class="funnel-stage stage-sale"><small>Alta espontánea</small><strong>${value(spontaneousSales)}</strong></div></div><div class="funnel-total"><span>Altas espontáneas</span><strong>${value(spontaneousSales)}</strong></div></section>`;
  const sourceBreakdown = Array.isArray(lead.leadVisitSourceBreakdown) && lead.leadVisitSourceBreakdown.length
    ? `<section class="visit-sidecard"><span class="objective-label">Fuentes de visitas</span><ul class="tariff-conversion-list">${lead.leadVisitSourceBreakdown.map((row) => `<li><span>${row.source}</span><strong>${fmtNumber.format(row.percentage)}%</strong><small>${value(row.visits)} visitas</small></li>`).join("")}</ul></section>`
    : "";
  const balanceCard = balanceSales != null && balanceSales !== 0
    ? `<section class="visit-sidecard"><span class="objective-label">${balanceSales >= 0 ? "Resto sin clasificar" : "Descuadre"}</span><div class="visit-balance"><strong>${value(balanceSales)}</strong><span>${value(totalMemberships)} altas totales</span></div></section>`
    : "";
  const attributedSalesPanel = attributedSalesList
    ? `<section class="visit-sidecard visit-attributed">${attributedSalesList}</section>`
    : "";
  return `<div class="visit-metrics">${leadFunnelGraphic}${sourceBreakdown}${spontaneousFunnelGraphic}${balanceCard}${attributedSalesPanel}</div>`;
}

function render(data) {
  dashboard = data;
  const live = data.clubs.filter((club) => club.freshness === "live").length;
  const stale = data.clubs.filter((club) => club.freshness === "stale").length;
  const off = data.clubs.length - live - stale;
  renderBanner(data.clubs);
  document.querySelector("#connection-count").textContent = `${live}/${data.clubs.length} centros en tiempo real`;
  document.querySelector("#total-memberships").textContent = value(data.totals.memberships || null);
  document.querySelector("#total-cancellations").textContent = value(data.clubs.some(c => c.cancellations !== null) ? data.totals.cancellations : null);
  document.querySelector("#total-revenue").textContent = value(data.totals.revenue || null, fmtCurrency);
  document.querySelector("#total-billing").textContent = value(data.clubs.some(c => c.billing !== null) ? data.totals.billing : null, fmtCurrency);
  document.querySelector("#finance-revenue").textContent = value(data.clubs.some(c => c.revenue !== null) ? data.totals.revenue : null, fmtCurrency);
  document.querySelector("#finance-billing").textContent = value(data.clubs.some(c => c.billing !== null) ? data.totals.billing : null, fmtCurrency);
  document.querySelector("#live-count").textContent = live;
  document.querySelector("#stale-count").textContent = stale;
  document.querySelector("#off-count").textContent = off;
  const coverage = Math.round((live / data.clubs.length) * 100);
  document.querySelector("#coverage").textContent = `${coverage}%`;
  document.querySelector("#donut").style.setProperty("--coverage", `${coverage}%`);
  document.querySelector("#last-update").textContent = `Interfaz actualizada ${new Date(data.generatedAt).toLocaleString("es-ES")}`;
  document.querySelector("#group-panels").innerHTML = (data.groups ?? []).map((group) => `<article class="group-panel ${group.key}"><div><span>${group.name}</span><strong>${group.connected}/${group.clubs}</strong><small>centros conectados</small></div><dl><div><dt>Altas hoy</dt><dd>${value(group.memberships)}</dd></div><div><dt>Bajas hoy</dt><dd>${value(group.cancellations)}</dd></div><div><dt>Cobros hoy</dt><dd>${value(group.revenue, fmtCurrency)}</dd></div><div><dt>Facturación hoy</dt><dd>${value(group.billing, fmtCurrency)}</dd></div></dl></article>`).join("");
  document.querySelector("#member-cards").innerHTML = data.clubs.map((club) => `<section class="watch-card"><div><strong>${club.name}</strong><small>${club.ownership === "owned" ? "Propio" : "Franquiciado"}</small></div><strong>${value(club.members)}</strong></section>`).join("");
  document.querySelector("#objective-cards").innerHTML = data.objectives?.length
    ? data.objectives.map((objective) => { const club = data.clubs.find((row) => row.slug === objective.slug); return `<details class="objective-club" open><summary class="objective-club-head"><h3>${objective.name}</h3><span>Facturación del mes: <strong>${value(objective.actual?.billing, fmtCurrency)}</strong> <i>⌄</i></span></summary><div class="objective-metrics">${objectiveMetric("Altas", objective.actual?.memberships, objective.target.memberships, objective.percentage.memberships, "memberships")}${objectiveMetric("Bajas", objective.actual?.cancellations, objective.target.cancellations, objective.percentage.cancellations, "cancellations", `${value(objective.actual?.incidences?.oneMonthCancellations)} de abono 1 mes`)}${objectiveMetric("Activos", objective.actual?.activeNet, objective.target.activeNet, objective.percentage.activeNet, "activeNet")}${objectiveMetric("Merch (€)", objective.actual?.merch, objective.target.merch, objective.percentage.merch, "merch")}${objectiveMetric("Suplementación (€)", objective.actual?.supplements, objective.target.supplements, objective.percentage.supplements, "supplements")}${objectiveMetric("TIES", objective.actual?.ties, objective.target.ties, objective.percentage.ties, "ties")}${objectiveMetric("Cambios de fórmula", objective.actual?.formulaChanges, objective.target.formulaChanges, objective.percentage.formulaChanges, "formulaChanges")}${factualMetric("Pases de día vendidos", value(objective.actual?.dayPasses), `${value(objective.actual?.dayPassCustomers)} compradores únicos`, "dayPasses")}${factualMetric("Repetidores pase diario", value(objective.actual?.commercialIndicators?.repeatDayPassCustomers), "más de un pase este mes", "dayPassRepeaters")}${factualMetric("Referidores ≤10 días", value(objective.actual?.commercialIndicators?.earlyReferrers), `${value(objective.actual?.commercialIndicators?.earlyReferrals)} referidos aportados`, "earlyReferrers")}${visitFunnelMetrics(club)}</div></details>`; }).join("")
    : `<p class="objective-empty">No hay objetivos configurados.</p>`;
  document.querySelectorAll("#objective-cards .objective-club").forEach((card, index) => {
    const objective = data.objectives[index];
    const club = data.clubs.find((row) => row.slug === objective.slug);
    const metrics = card.querySelector(".objective-metrics");
    metrics.insertAdjacentHTML(
      "beforeend",
      `${tariffConversionMetric(club?.salesFunnel, objective.actual?.memberships ?? club?.monthToDate?.memberships ?? club?.memberships)}${membershipSourcesMetric(objective.actual)}`,
    );
  });
  document.querySelector("#incidence-incomplete-total").textContent = value(data.incidences?.totals?.incompleteMemberships);
  document.querySelector("#incidence-full-period-total").textContent = value(data.incidences?.totals?.fullPeriodCancellations);
  document.querySelector("#incidence-payment-total").textContent = value(data.incidences?.totals?.paymentIncidences);
  document.querySelector("#incidence-signature-total").textContent = value(data.incidences?.totals?.signatureIncidences);
  document.querySelector("#incidence-cards").innerHTML = (data.incidences?.clubs ?? []).map((club) => `<section class="incidence-card"><div><strong>${club.name}</strong><small>${club.ownership === "owned" ? "Propio" : "Franquiciado"}</small></div><dl><div><dt>Altas incompletas</dt><dd>${value(club.incompleteMemberships)}</dd></div><div><dt>Bajas solicitadas pendientes</dt><dd>${value(club.pendingCancellations)}</dd><small>${club.nextPendingCancellationDate ? `Próxima: ${new Date(`${club.nextPendingCancellationDate}T12:00:00`).toLocaleDateString("es-ES")}` : "Sin fecha próxima"}</small></div><div><dt>Período completo</dt><dd>${value(club.fullPeriodCancellations)}</dd></div><div><dt>Abono 1 mes</dt><dd>${value(club.oneMonthCancellations)}</dd></div><div><dt>Sistema · solo devolución</dt><dd>${value(club.automaticReturnFeeOnly)}</dd></div><div class="incidence-payment"><dt>Incidencias de pago</dt><dd>${value(club.paymentIncidences)}</dd><small>${stateDetail(club.paymentIncidenceStates)}</small></div><div class="incidence-signature"><dt>Altas sin firmar</dt><dd>${value(club.signatureIncidences)}</dd><small>${stateDetail(club.signatureIncidenceStates)}</small></div></dl></section>`).join("");
  document.querySelector("#watch-period").textContent = data.watchData?.period?.label ?? "Pendiente";
  document.querySelector("#watch-cards").innerHTML = (data.watchData?.clubs ?? []).map((club) => `<section class="watch-card"><div><strong>${club.name}</strong><small>${club.ownership === "owned" ? "Propio" : "Franquiciado"}</small></div><strong>${value(club.count)}</strong></section>`).join("");

  document.querySelector("#club-bars").innerHTML = data.clubs.map((club) => {
    const cancel = club.cancellations ?? 0;
    return `<div class="bar-row"><span title="${club.name}">${club.name}</span><div class="bars"><i style="width:${club.memberships ? Math.min(100, club.memberships) : 3}%"></i><i style="width:${cancel ? Math.min(100, cancel * 5) : 3}%"></i></div><b>${club.cancellations ?? "—"}</b></div>`;
  }).join("");
  drawTable(data.clubs);
}

function drawTable(clubs) {
  document.querySelector("#club-table").innerHTML = clubs.map((club) => `<tr><td><strong>${club.name}</strong><small>${club.id}</small></td><td>${club.ownership === "owned" ? "Propio" : "Franquiciado"}</td><td><span class="badge ${club.freshness}"${club.lastError ? ` title="${escapeAttribute(club.lastError)}"` : ""}>${statusLabel(club.freshness)}</span></td><td>${value(club.members)}</td><td>${value(club.memberships)}</td><td>${value(club.cancellations)}</td><td>${value(club.revenue, fmtCurrency)}</td><td>${value(club.billing, fmtCurrency)}</td><td>${club.sourcePeriod ?? "—"}</td></tr>`).join("");
}

async function load() {
  const button = document.querySelector("#refresh");
  button.disabled = true;
  button.textContent = "Actualizando…";
  try {
    render(await fetch("/api/dashboard", { cache: "no-store" }).then((response) => response.json()));
  } finally {
    button.disabled = false;
    button.textContent = "Actualizar";
  }
}

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".nav-item,.view").forEach((element) => element.classList.remove("active"));
  button.classList.add("active");
  document.querySelector(`#${button.dataset.view}-view`).classList.add("active");
  document.querySelector("#page-title").textContent = { summary: "Visión general", clubs: "Rendimiento por centro", finance: "Finanzas" }[button.dataset.view];
}));
document.querySelector("#refresh").addEventListener("click", load);
document.querySelector("#club-search").addEventListener("input", (event) => drawTable(dashboard.clubs.filter((club) => club.name.toLowerCase().includes(event.target.value.toLowerCase()))));
load();
setInterval(load, 300_000);
