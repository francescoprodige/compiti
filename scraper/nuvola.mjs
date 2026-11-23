// Legge compiti e verifiche da Nuvola (area tutore) e li manda all'app Compiti.
// Variabili d'ambiente (GitHub Secrets): NUVOLA_USER, NUVOLA_PASS, IMPORT_SECRET
// Opzionali: SUPABASE_URL, SUPABASE_KEY, DEBUG=1 (salva pagine e screenshot in ./debug)
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "https://nuvola.madisoft.it";
const SB_URL = process.env.SUPABASE_URL || "https://ukjpemlqushmuakswoww.supabase.co";
const SB_KEY = process.env.SUPABASE_KEY || "sb_publishable_zqMoAof9UjILkFp2TlDPtQ_-1BfpDjN";
const { NUVOLA_USER, NUVOLA_PASS, IMPORT_SECRET } = process.env;
const DEBUG = process.env.DEBUG === "1";
const WEEKS = 3; // settimana corrente + le due successive (copre le verifiche a 14 giorni)

const MESI = { gennaio:1, febbraio:2, marzo:3, aprile:4, maggio:5, giugno:6, luglio:7, agosto:8, settembre:9, ottobre:10, novembre:11, dicembre:12,
  gen:1, feb:2, mar:3, apr:4, mag:5, giu:6, lug:7, ago:8, set:9, ott:10, nov:11, dic:12 };
const GIORNI = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
// Frasi esplicite: la verifica è data per confermata
const CONFERMA = /\b(fissat[ao]|programmat[ao]|stabilit[ao]|si terr[àa]|si svolger[àa]|ci sar[àa])\b/i;
const PAROLE_VERIFICA = /\b(verifica|verifiche|interrogazion[ei]|interrogat[oi]|compito in classe|prova scritta|test)\b/i;

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const titolo = (s) => { const t = s.trim().toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
const oggi = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d; };
const lunedi = (d) => { const x = new Date(d); const g = (x.getDay() + 6) % 7; x.setDate(x.getDate() - g); return x; };
const addGiorni = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

async function rpc(fn, args) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}

async function dump(page, nome) {
  if (!DEBUG) return;
  fs.mkdirSync("debug", { recursive: true });
  await page.screenshot({ path: `debug/${nome}.png`, fullPage: true }).catch(() => {});
  const testo = await testoPagina(page).catch(() => "");
  fs.writeFileSync(`debug/${nome}.txt`, testo);
  await rpc("salva_debug", { segreto: IMPORT_SECRET, p_nome: nome, p_url: page.url(), p_testo: testo }).catch(() => {});
}

async function testoPagina(page) {
  return page.evaluate(() => (document.querySelector("main") || document.body).innerText);
}

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="password"]', { timeout: 30000 });
  await dump(page, "01-login");
  await page.locator('input[name="username"], #text-input-username, input[autocomplete="username"]').first().fill(NUVOLA_USER.trim());
  await page.locator('input[name="password"], input[type="password"]').first().fill(NUVOLA_PASS);
  await Promise.all([
    page.waitForURL((u) => u.hostname === "nuvola.madisoft.it", { timeout: 45000 }).catch(() => null),
    page.locator('button[type="submit"], input[type="submit"]').first().click(),
  ]);
  await page.waitForLoadState("networkidle").catch(() => {});
  const url = new URL(page.url());
  if (url.hostname !== "nuvola.madisoft.it") {
    await dump(page, "02-login-fallito");
    const msg = await page.evaluate(() => {
      const el = document.querySelector('[class*="error" i], [class*="alert" i], [id*="error" i], [role="alert"]');
      return (el ? el.innerText : document.body.innerText).replace(/\s+/g, " ").trim().slice(0, 160);
    }).catch(() => "");
    throw new Error(`Login a Nuvola non riuscito (pagina: ${url.hostname}${url.pathname}). Messaggio: ${msg}`);
  }
}

async function elencoFigli(page) {
  await page.goto(`${BASE}/area-tutore/alunni?redirect=false`, { waitUntil: "networkidle" });
  await dump(page, "03-alunni");
  const testo = await testoPagina(page);
  // Righe tipo: "Nome Cognome" seguita da "3C • Scuola Secondaria di I grado ... • 2026/2027 • F"
  const righe = testo.split("\n").map((s) => s.trim()).filter(Boolean);
  const figli = [];
  for (let i = 0; i < righe.length - 1; i++) {
    const info = righe[i + 1];
    if (/•/.test(info) && /\d{4}\/\d{4}/.test(info) && !/•/.test(righe[i])) {
      const nomeCompleto = righe[i];
      const nome = nomeCompleto.split(/\s+/)[0];
      const classe = info.split("•")[0].trim();
      const scuola = /primaria/i.test(info) ? "Primaria" : /secondaria di i grado/i.test(info) ? "Media" : /secondaria/i.test(info) ? "Superiori" : "";
      figli.push({ id: slug(nome), nome: titolo(nome), nomeCompleto, classe: classe + (scuola ? " · " + scuola : "") });
    }
  }
  if (!figli.length) throw new Error("Non trovo l'elenco dei figli nella pagina alunni");
  return figli;
}

async function scegliFiglio(page, figlio) {
  await page.goto(`${BASE}/area-tutore/alunni?redirect=false`, { waitUntil: "networkidle" });
  await page.getByText(figlio.nomeCompleto, { exact: false }).first().click();
  await page.waitForURL((u) => !u.pathname.endsWith("/alunni"), { timeout: 20000 });
}

function dataDaTesto(testo, riferimento) {
  // "giovedì 22 ottobre" -> Date; anno scelto per stare vicino al riferimento
  const m = testo.toLowerCase().match(/(\d{1,2})\s+([a-zà]+)/);
  if (!m || !MESI[m[2]]) return null;
  const d = new Date(riferimento.getFullYear(), MESI[m[2]] - 1, Number(m[1]), 12);
  if (d - riferimento > 1000 * 3600 * 24 * 180) d.setFullYear(d.getFullYear() - 1);
  if (riferimento - d > 1000 * 3600 * 24 * 180) d.setFullYear(d.getFullYear() + 1);
  return d;
}

// Analizza il testo della vista settimanale dei compiti
function analizzaSettimana(testo, inizioSettimana, figlioId) {
  const r = testo.split("\n").map((s) => s.trim()).filter(Boolean);
  const out = [];
  let giorno = null;
  let i = 0;
  const isGiorno = (k) => GIORNI.includes((r[k] || "").toLowerCase()) && /^\d{1,2}$/.test(r[k + 1] || "");
  const isBlocco = (k) => /^compiti assegnati/i.test(r[k + 2] || "") && r[k] && r[k] === r[k].toUpperCase() && /[A-Z]/.test(r[k]);
  while (i < r.length) {
    if (isGiorno(i)) {
      const idx = GIORNI.indexOf(r[i].toLowerCase());
      giorno = addGiorni(inizioSettimana, idx);
      if (giorno.getDate() !== Number(r[i + 1])) giorno = dataDaTesto(`${r[i + 1]} ${giorno.toLocaleString("it-IT", { month: "long" })}`, giorno) || giorno;
      i += 2;
      continue;
    }
    if (giorno && isBlocco(i)) {
      const materia = titolo(r[i]);
      const docente = r[i + 1];
      const assegnato = dataDaTesto(r[i + 2].replace(/^compiti assegnati/i, ""), giorno);
      let j = i + 3;
      const righe = [];
      let argomento = "";
      while (j < r.length && !isGiorno(j) && !isBlocco(j)) {
        if (/^argomento collegato$/i.test(r[j])) { argomento = r[j + 1] || ""; j += 2; continue; }
        if (/^allegati$/i.test(r[j])) { j++; while (j < r.length && !isGiorno(j) && !isBlocco(j) && !/^argomento collegato$/i.test(r[j])) j++; righe.push("(c'è un allegato su Nuvola)"); continue; }
        if (/^nessun compito/i.test(r[j])) { j++; continue; }
        righe.push(r[j]);
        j++;
      }
      out.push({ figlio: figlioId, data: iso(giorno), materia, docente, assegnato: assegnato ? iso(assegnato) : null, testo: righe.join("\n"), argomento });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

function assegnaId(compiti) {
  const gruppi = new Map();
  for (const c of compiti) {
    const k = `${c.figlio}-${c.data.replaceAll("-", "")}-${slug(c.materia)}`;
    if (!gruppi.has(k)) gruppi.set(k, []);
    gruppi.get(k).push(c);
  }
  for (const [k, lista] of gruppi) lista.forEach((c, n) => (c.id = lista.length > 1 ? `${k}-${n + 1}` : k));
  return compiti;
}

// Analizza la vista settimanale degli argomenti di lezione -> [{data, materia, testo}]
function analizzaArgomenti(testo, inizioSettimana) {
  const r = testo.split("\n").map((s) => s.trim()).filter(Boolean);
  const out = [];
  let giorno = null, materia = null;
  const isGiorno = (k) => GIORNI.includes((r[k] || "").toLowerCase()) && /^\d{1,2}$/.test(r[k + 1] || "");
  const isMateria = (x) => x && x === x.toUpperCase() && /[A-Z]{3,}/.test(x) && x.length < 50 && !/^\d/.test(x);
  for (let i = 0; i < r.length; i++) {
    if (isGiorno(i)) {
      giorno = addGiorni(inizioSettimana, GIORNI.indexOf(r[i].toLowerCase()));
      i++; materia = null; continue;
    }
    if (!giorno) continue;
    if (/^\d+ᵃ ora$/i.test(r[i]) || /^\d+\S* ora$/i.test(r[i])) { materia = null; if (/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(r[i + 1] || "")) i++; continue; }
    if (/^nessun argomento$/i.test(r[i])) { materia = null; continue; }
    if (isMateria(r[i])) { materia = titolo(r[i]); continue; }
    if (materia) out.push({ data: iso(giorno), materia, testo: r[i] });
  }
  return out;
}

// Cerca verifiche/interrogazioni:
// 1) argomenti di lezione di oggi o futuri (programmati dal prof) -> giorno della lezione
// 2) argomenti passati che annunciano una data (es. "verifica del 6/11")
// 3) testo dei compiti ("ripassare per la verifica") -> giorno di consegna
function trovaVerifiche(compiti, argomenti, figlioId, dal, al) {
  const out = new Map();
  const peso = { confermata: 2, da_confermare: 1 };
  const add = (v) => {
    if (v.data < dal || v.data > al) return;
    const k = `${v.figlio}-${v.data.replaceAll("-", "")}-${slug(v.materia)}`;
    const old = out.get(k);
    if (!old || peso[v.stato] > peso[old.stato] || (peso[v.stato] === peso[old.stato] && v.programmata)) out.set(k, { ...v, id: k });
  };
  const tipo = (s) => (/interrog/i.test(s) ? "Interrogazione" : /\btema\b/i.test(s) ? "Tema" : "Verifica");
  const nonVerifica = /correzion|corrett|consegna|restituzion|valutazion|recupero/i;
  const condizionale = /\b(in caso|se la|se il|eventualmente|forse|da definire)\b/i;
  for (const c of compiti) {
    if (PAROLE_VERIFICA.test(c.testo)) add({ figlio: c.figlio, data: c.data, materia: c.materia, tipo: tipo(c.testo), descrizione: c.testo.split("\n")[0].slice(0, 160), stato: "da_confermare", fonte: "testo compiti" });
  }
  const oggiIso = iso(oggi());
  for (const a of argomenti) {
    const parola = PAROLE_VERIFICA.test(a.testo) || /\btema\b/i.test(a.testo) || /\bV\.\s/.test(a.testo);
    if (!parola) continue;
    if (a.data >= oggiIso && !nonVerifica.test(a.testo)) {
      add({ figlio: figlioId, data: a.data, materia: a.materia, tipo: tipo(a.testo), descrizione: a.testo.slice(0, 160), stato: condizionale.test(a.testo) ? "da_confermare" : "confermata", fonte: "argomenti di lezione", programmata: true });
    } else if (a.data < oggiIso) {
      const date = a.testo.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g) || [];
      for (const d0 of date) {
        const [g, m] = d0.split("/").map(Number);
        const d = new Date(oggi().getFullYear(), m - 1, g, 12);
        if (oggi() - d > 1000 * 3600 * 24 * 180) d.setFullYear(d.getFullYear() + 1);
        add({ figlio: figlioId, data: iso(d), materia: a.materia, tipo: tipo(a.testo), descrizione: a.testo.slice(0, 160), stato: CONFERMA.test(a.testo) && date.length === 1 ? "confermata" : "da_confermare", fonte: "argomenti di lezione" });
      }
    }
  }
  return [...out.values()].map(({ programmata, ...v }) => v);
}

// Voti: righe "MATERIA", poi coppie voto / data ("8½" / "13 nov")
const MESI3 = { gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12 };
function annoScolastico(mese) { const o = oggi(); const inizio = o.getMonth() + 1 >= 9 ? o.getFullYear() : o.getFullYear() - 1; return mese >= 9 ? inizio : inizio + 1; }
function valoreVoto(v) {
  const m = v.replace(",", ".").match(/^(\d+(?:\.\d+)?)(½|\+|-|\/(\d+))?$/);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[2] === "½") n += 0.5; else if (m[2] === "+") n += 0.25; else if (m[2] === "-") n -= 0.25; else if (m[3]) n = (n + Number(m[3])) / 2;
  return n >= 0 && n <= 10 ? Math.round(n * 100) / 100 : null;
}
function analizzaVoti(testo, figlioId) {
  const r = testo.split("\n").map((x) => x.trim()).filter(Boolean);
  const isData = (x) => /^(\d{1,2}) ([a-z]{3})$/i.test(x || "");
  const out = []; let materia = null;
  const start = r.findIndex((x) => /^INTERO ANNO$/i.test(x));
  for (let i = start + 1; i < r.length; i++) {
    if (isData(r[i + 1])) {
      if (!materia) continue;
      const [, g, m] = r[i + 1].match(/^(\d{1,2}) ([a-z]{3})$/i);
      const mese = MESI3[m.toLowerCase()]; if (!mese) { i++; continue; }
      const d = `${annoScolastico(mese)}-${pad(mese)}-${pad(Number(g))}`;
      out.push({ figlio: figlioId, materia, data: d, voto: r[i], valore: valoreVoto(r[i]) });
      i++; continue;
    }
    if (/^nessun voto$/i.test(r[i]) || /errore|autorizzato/i.test(r[i])) continue;
    if (r[i] === r[i].toUpperCase() && /[A-Z]{3,}/.test(r[i])) materia = titolo(r[i]);
  }
  // id stabile: figlio-materia-data-n (n = ordine tra voti uguali per materia e giorno)
  const cnt = {};
  for (const v of out) { const k = `${v.figlio}-${slug(v.materia)}-${v.data.replaceAll("-", "")}`; cnt[k] = (cnt[k] || 0) + 1; v.id = `${k}-${cnt[k]}`; }
  return out;
}
// Note: terne MATERIA / TIPO / gg-mm-aaaa
function analizzaNote(testo, figlioId) {
  const r = testo.split("\n").map((x) => x.trim()).filter(Boolean);
  const out = []; const cnt = {};
  for (let i = 0; i < r.length; i++) {
    const m = (r[i] || "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!m || i < 2) continue;
    const data = `${m[3]}-${m[2]}-${m[1]}`;
    const tipo = titolo(r[i - 1]), materia = titolo(r[i - 2]);
    const k = `${figlioId}-${data.replaceAll("-", "")}-${slug(materia)}-${slug(tipo)}`; cnt[k] = (cnt[k] || 0) + 1;
    out.push({ id: `${k}-${cnt[k]}`, figlio: figlioId, materia, tipo, data });
  }
  return out;
}

async function main() {
  if (!NUVOLA_USER || !NUVOLA_PASS || !IMPORT_SECRET) throw new Error("Mancano NUVOLA_USER, NUVOLA_PASS o IMPORT_SECRET");
  const browser = await chromium.launch();
  const page = await browser.newPage({ locale: "it-IT", timezoneId: "Europe/Rome" });
  try {
    await login(page);
    const figli = await elencoFigli(page);
    const lun = lunedi(oggi());
    const dal = iso(lun);
    const al = iso(addGiorni(lun, WEEKS * 7 - 1));
    const tuttiCompiti = [];
    const tuttiVoti = [];
    const tutteNote = [];
    const tutteVerifiche = [];
    for (const f of figli) {
      await scegliFiglio(page, f);
      const suoi = [];
      for (let w = 0; w < WEEKS; w++) {
        const inizio = addGiorni(lun, w * 7);
        await page.goto(`${BASE}/area-tutore/compiti?data=${iso(addGiorni(inizio, 3))}&vista=settimana`, { waitUntil: "networkidle" });
        await page.waitForTimeout(800);
        await dump(page, `10-${f.id}-compiti-${w}`);
        suoi.push(...analizzaSettimana(await testoPagina(page), inizio, f.id));
      }
      const argomenti = [];
      for (let w = -2; w < WEEKS; w++) {
        const inizio = addGiorni(lun, w * 7);
        await page.goto(`${BASE}/area-tutore/argomenti-lezione?data=${iso(addGiorni(inizio, 3))}&vista=settimana`, { waitUntil: "networkidle" }).catch(() => {});
        await page.waitForTimeout(800);
        await dump(page, `20-${f.id}-argomenti-${w}`);
        argomenti.push(...analizzaArgomenti(await testoPagina(page).catch(() => ""), inizio));
      }
      try {
        await page.goto(`${BASE}/area-tutore/voti`, { waitUntil: "networkidle" });
        await page.getByText("INTERO ANNO", { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1200);
        await dump(page, `30-${f.id}-voti`);
        tuttiVoti.push(...analizzaVoti(await testoPagina(page), f.id));
        await page.goto(`${BASE}/area-tutore/note`, { waitUntil: "networkidle" });
        await page.waitForTimeout(800);
        await dump(page, `30-${f.id}-note`);
        tutteNote.push(...analizzaNote(await testoPagina(page), f.id));
      } catch (e) { console.warn(`Voti/note di ${f.nome} non letti: ${e.message}`); }
      assegnaId(suoi);
      tuttiCompiti.push(...suoi);
      tutteVerifiche.push(...trovaVerifiche(suoi, argomenti, f.id, iso(oggi()), iso(addGiorni(oggi(), 14))));
      console.log(`${f.nome}: ${suoi.length} compiti`);
    }
    if (!tuttiCompiti.length) throw new Error("Nessun compito letto: forse Nuvola ha cambiato le pagine");
    const pulisci = ({ argomento, ...c }) => c;
    const res = await rpc("importa", {
      segreto: IMPORT_SECRET, dal, al, figli: figli.map((f) => f.id),
      p_compiti: tuttiCompiti.map(pulisci), p_verifiche: tutteVerifiche,
    });
    await rpc("imposta_figli", { segreto: IMPORT_SECRET, p_figli: figli.map(({ nomeCompleto, ...f }) => f) }).catch((e) => console.warn(e.message));
    const rv = await rpc("importa_voti", { segreto: IMPORT_SECRET, figli: figli.map((f) => f.id), p_voti: tuttiVoti, p_note: tutteNote });
    console.log("Voti/note:", tuttiVoti.length, tutteNote.length, rv);
    console.log("Importato:", res, "verifiche trovate:", tutteVerifiche.length);
  } catch (e) {
    console.error(e.message);
    await rpc("segnala_errore", { segreto: IMPORT_SECRET, messaggio: e.message.slice(0, 300) }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
