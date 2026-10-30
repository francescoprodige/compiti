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
const WEEKS = 2; // settimana corrente + successiva

const MESI = { gennaio:1, febbraio:2, marzo:3, aprile:4, maggio:5, giugno:6, luglio:7, agosto:8, settembre:9, ottobre:10, novembre:11, dicembre:12,
  gen:1, feb:2, mar:3, apr:4, mag:5, giu:6, lug:7, ago:8, set:9, ott:10, nov:11, dic:12 };
const GIORNI = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
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
  fs.writeFileSync(`debug/${nome}.txt`, await testoPagina(page).catch(() => ""));
}

async function testoPagina(page) {
  return page.evaluate(() => (document.querySelector("main") || document.body).innerText);
}

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="password"]', { timeout: 30000 });
  await dump(page, "01-login");
  const user = page.locator('input[type="email"], input[name*="user" i], input[name*="email" i], input[autocomplete="username"], input[type="text"]').first();
  await user.fill(NUVOLA_USER);
  await page.locator('input[type="password"]').first().fill(NUVOLA_PASS);
  await page.locator('input[type="password"]').first().press("Enter");
  await page.waitForURL(/area-tutore/, { timeout: 45000 }).catch(async () => {
    await dump(page, "02-login-fallito");
    throw new Error("Login a Nuvola non riuscito: controlla utente e password");
  });
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

// Cerca verifiche/interrogazioni: nel testo dei compiti (stesso giorno) e negli argomenti di lezione (date tipo 6/11)
function trovaVerifiche(compiti, argomentiTesto, figlioId, dal, al) {
  const out = new Map();
  const add = (v) => { if (v.data >= dal && v.data <= al) out.set(`${v.figlio}-${v.data.replaceAll("-", "")}-${slug(v.materia)}`, v); };
  const tipo = (s) => (/interrog/i.test(s) ? "Interrogazione" : "Verifica");
  for (const c of compiti) {
    if (PAROLE_VERIFICA.test(c.testo)) add({ figlio: c.figlio, data: c.data, materia: c.materia, tipo: tipo(c.testo), descrizione: c.testo.split("\n")[0].slice(0, 160), stato: "da_confermare", fonte: "testo compiti" });
  }
  // Argomenti di lezione: righe con parola chiave e una data gg/mm
  const righe = argomentiTesto.split("\n").map((s) => s.trim()).filter(Boolean);
  let materiaCorrente = "";
  for (const riga of righe) {
    if (riga === riga.toUpperCase() && /[A-Z]{3,}/.test(riga) && riga.length < 40) { materiaCorrente = titolo(riga); continue; }
    const conParola = PAROLE_VERIFICA.test(riga) || /\bV\.\s/.test(riga);
    const dm = riga.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (conParola && dm && materiaCorrente) {
      const ref = oggi();
      const d = new Date(ref.getFullYear(), Number(dm[2]) - 1, Number(dm[1]), 12);
      if (ref - d > 1000 * 3600 * 24 * 180) d.setFullYear(d.getFullYear() + 1);
      add({ figlio: figlioId, data: iso(d), materia: materiaCorrente, tipo: tipo(riga), descrizione: riga.slice(0, 160), stato: "da_confermare", fonte: "argomenti di lezione" });
    }
  }
  return [...out.values()].map((v) => ({ ...v, id: `${v.figlio}-${v.data.replaceAll("-", "")}-${slug(v.materia)}` }));
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
      let argomenti = "";
      for (let w = -2; w < 1; w++) {
        const inizio = addGiorni(lun, w * 7);
        await page.goto(`${BASE}/area-tutore/argomenti-lezione?data=${iso(addGiorni(inizio, 3))}&vista=settimana`, { waitUntil: "networkidle" }).catch(() => {});
        await page.waitForTimeout(800);
        await dump(page, `20-${f.id}-argomenti-${w}`);
        argomenti += "\n" + (await testoPagina(page).catch(() => ""));
      }
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
