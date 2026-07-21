// Database layer — node:sqlite (Node 22.5+, zero native deps).
// SQLite file lives on a persistent volume in production (see SETUP-GUIDE.md).
// Swap this single file for Postgres if the business outgrows one server.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'estate.db'));
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS price_items (
  id TEXT PRIMARY KEY, code TEXT, name TEXT NOT NULL, unit TEXT,
  behaviour TEXT DEFAULT 'none', -- none|remeasurable|rate_only|optional|allowance
  basic_spec TEXT, basic_sell REAL DEFAULT 0, basic_cost REAL DEFAULT 0,
  standard_spec TEXT, standard_sell REAL DEFAULT 0, standard_cost REAL DEFAULT 0,
  premium_spec TEXT, premium_sell REAL DEFAULT 0, premium_cost REAL DEFAULT 0,
  notes TEXT, sort_order INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS surcharges (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger_note TEXT,
  kind TEXT DEFAULT 'percent', -- percent|fixed
  rate REAL DEFAULT 0, sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL,
  parent_number TEXT, quote_number TEXT,
  project_title TEXT, client_name TEXT, client_email TEXT, address TEXT,
  quote_date TEXT, validity_days INTEGER DEFAULT 14,
  default_package TEXT DEFAULT 'Standard',
  payment_schedule TEXT DEFAULT 'standard', -- standard|small
  site_notes TEXT DEFAULT '',
  special_clauses TEXT DEFAULT '',
  siteplan_data TEXT, siteplan_mime TEXT,
  applied_surcharges TEXT DEFAULT '[]', -- JSON [{id,name,kind,rate}]
  status TEXT DEFAULT 'draft', -- draft|viewed|accepted|superseded
  accepted_package TEXT, accepted_at TEXT,
  signed_name TEXT, signed_sig TEXT, signed_ip TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quote_items (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  scope INTEGER DEFAULT 1,
  price_item_id TEXT REFERENCES price_items(id) ON DELETE SET NULL,
  custom_code TEXT, custom_name TEXT, custom_unit TEXT, custom_rate REAL,
  qty REAL DEFAULT 1,
  tier_override TEXT,
  behaviour_override TEXT,
  shared_enabled INTEGER DEFAULT 0, shared_pct REAL DEFAULT 50,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS quote_events (
  id TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, payload TEXT, created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checklist_template (
  id TEXT PRIMARY KEY, sort_order INTEGER DEFAULT 0, category TEXT, label TEXT, critical INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS quote_checklist (
  id TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  template_item_id TEXT, sort_order INTEGER DEFAULT 0, category TEXT, label TEXT,
  critical INTEGER DEFAULT 0, checked INTEGER DEFAULT 0, checked_by TEXT, checked_at TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, actor TEXT, action TEXT, detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ---------------- NON-DESTRUCTIVE MIGRATION ----------------
// Adds new columns/tables to an EXISTING database without deleting data.
// Safe to run on every boot: duplicate-column errors are ignored.
function addColumn(table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (e) { /* already exists */ }
}
// Rate-lock: each quote item snapshots the tier specs+rates at add-time so
// later pricing-sheet edits never change a quote that's already been built.
addColumn('quote_items', 'locked_basic_spec', 'TEXT');
addColumn('quote_items', 'locked_basic_sell', 'REAL');
addColumn('quote_items', 'locked_standard_spec', 'TEXT');
addColumn('quote_items', 'locked_standard_sell', 'REAL');
addColumn('quote_items', 'locked_premium_spec', 'TEXT');
addColumn('quote_items', 'locked_premium_sell', 'REAL');
addColumn('quote_items', 'locked_behaviour', 'TEXT');
// Quote-level: N/A choices (compulsory surcharge & siteplan), completeness
addColumn('quotes', 'siteplan_na', 'INTEGER DEFAULT 0');
addColumn('quotes', 'surcharges_na', 'INTEGER DEFAULT 0');
addColumn('quotes', 'is_complete', 'INTEGER DEFAULT 0');

// Purchase Orders
db.exec(`
CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY, quote_id TEXT REFERENCES quotes(id) ON DELETE CASCADE,
  po_number TEXT, client_name TEXT, address TEXT,
  siteplan_data TEXT, siteplan_mime TEXT, site_challenges TEXT DEFAULT '[]',
  status TEXT DEFAULT 'open', created_at TEXT DEFAULT (datetime('now')), closed_at TEXT
);
CREATE TABLE IF NOT EXISTS po_items (
  id TEXT PRIMARY KEY, po_id TEXT REFERENCES purchase_orders(id) ON DELETE CASCADE,
  code TEXT, name TEXT, spec TEXT, qty REAL, unit TEXT, removed INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS po_prints (
  id TEXT PRIMARY KEY, po_id TEXT REFERENCES purchase_orders(id) ON DELETE CASCADE,
  printed_by TEXT, printed_at TEXT DEFAULT (datetime('now'))
);
`);

function settingGet(key, fb = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : fb;
}
function settingSet(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
const uid = () => crypto.randomUUID();

// ---------------- SEED (first run only) ----------------
if (!settingGet('seeded_v2')) {
  settingSet('management_pin_hash', crypto.createHash('sha256').update('1234').digest('hex'));
  settingSet('company_name', 'Estate Landscapers');
  settingSet('company_abn', 'ABN 94 636 443 108');
  settingSet('company_lic', 'LIC 487076C');
  settingSet('company_address', '33/275 Annangrove Road, Rouse Hill NSW 2155');
  settingSet('company_location', '33/275 Annangrove Road, Rouse Hill NSW 2155');
  settingSet('company_email', 'info@estatelandscapers.com.au');
  settingSet('company_phone', '+61 414 147 008');
  settingSet('association_line', 'Member — Landscape Association NSW & ACT');
  settingSet('tagline', 'Integrity. Precision. Value.');
  settingSet('pkg_desc_basic', 'Practical, budget-conscious materials that meet council and DA requirements.');
  settingSet('pkg_desc_standard', 'Our most popular balance of durability, finish and street appeal.');
  settingSet('pkg_desc_premium', 'Designer materials and finishes for maximum property value.');
  settingSet('pay_sched_standard', "10% on acceptance · 20% on site establishment · 30% at 50% complete · 30% at 80% complete · 10% at practical completion");
  settingSet('pay_sched_small', "50% on acceptance · 40% on day 1 on site (site establishment) · 10% on completion of works");
  settingSet('warranty_text', [
    'All hard works carry a structural warranty in accordance with NSW HIA and Department of Fair Trading requirements.',
    'Statutory warranties under the Home Building Act 1989 (NSW) apply to all works — including due care and skill, compliance with plans and law, suitable materials, and fitness for purpose.',
    "Turf supplied with grower's Warranty Certificate and maintenance guide including weed management.",
    'Defects liability: notify us of any defect within 7 days of Practical Completion — confirmed defects are jointly inspected and rectified within an agreed timeframe at no cost to you.',
    'Warranty exclusions: client-supplied materials; plant failure from weather, maintenance, pests or external factors; works carried out at the Client\u2019s request in good faith and at no cost.',
  ].join('\n'));
  settingSet('protections_text', [
    'Licensed contractor — LIC 487076C|Licensed for structural landscaping under NSW Fair Trading.',
    'Fully insured|Public Liability, Workers Compensation, and Tools & Machinery insurance held and current on every job.',
    'Member — Landscape Association NSW & ACT|Bound by the association\u2019s professional standards.',
    'Transparent variations|No surprise costs — any change is quoted in writing and only proceeds with your approval.',
    'Progress payments tied to milestones|You only ever pay for stages as they are delivered.',
    'Joint defect inspection|Walkthrough together before Practical Completion, rectification dates agreed in writing.',
  ].join('\n'));
  settingSet('default_special_clauses', 'SC-1. Rock excavation, if encountered, charged at $120/hr + GST as a variation.\nSC-2. Exposed aggregate with off-white cement priced separately prior to pour.');
  settingSet('standard_conditions', `1. Definitions\nContract means the quotation, these Terms & Conditions, drawings, specifications, and any approved variations. Contractor means Estate Landscapers. Client means the person, company, or entity accepting the quotation and includes the registered owner of the property; where the Client and property owner differ, both shall be jointly and severally liable. Works means all labour, materials, equipment, and services described in the quotation and any approved variations. Contract Price means the total price stated in the quotation, subject to adjustment in accordance with this Contract. Practical Completion means the stage at which the Works are complete and fit for their intended purpose, with only minor defects that do not prevent use.\n\n2. Formation of Contract\nThis Contract becomes legally binding upon the earliest of: a) written acceptance of the quotation; b) payment of any deposit; or c) the Contractor commencing the Works.\n\n3. Contract Documents\nThe Contract comprises the quotation, these Terms & Conditions, drawings and specifications, and any written variations. In the event of inconsistency, the Contractor shall clarify and determine the applicable interpretation prior to execution of the Works.\n\n4. Contract Price\nThe Contract Price includes GST unless otherwise stated and is subject to adjustment in accordance with this Contract, including variations, latent conditions, and price escalation.\n\n5. Price Escalation and Market Adjustment\nDue to fluctuations in the construction and landscaping industry, the Contract Price is subject to adjustment for increases in material costs, supplier pricing, delivery and freight charges, fuel and logistics, and consumables including concrete, steel, timber, aggregates, and plant stock. Any such increase shall be supported by supplier documentation and shall be payable as a variation including the Contractor's standard margin. Where the duration of the Works exceeds three (3) months from commencement, the Contractor reserves the right to review the remaining scope and adjust pricing to reflect current market rates via a variation submitted for approval.\n\n6. Payment Terms\nAs per the payment schedule stated on the quotation. All payments are due within three (3) calendar days of invoice. Payments are not conditional upon third-party inspections, certifications, approvals, or minor defects. Failure to make payment when due constitutes a substantial breach and entitles the Contractor to suspend the Works.\n\n7. Security of Payment\nThe Contractor reserves all rights under the Building and Construction Industry Security of Payment Act 1999 (NSW).\n\n8. Scope of Works and Exclusions\nOnly works expressly stated in the quotation are included. All other works constitute variations, including rock excavation; relocation or adjustment of utilities; stormwater or hydraulic upgrades; engineering or design services; contaminated material or asbestos; latent site conditions.\n\n9. Variations\nNo variation shall be carried out unless approved in writing by the Client. Variations shall be valued using contract rates or reasonable market rates and shall include a margin of 20% for overhead, supervision, and profit.\n\n10. Latent Conditions\nLatent conditions include physical conditions differing materially from those reasonably anticipated, including rock, buried structures, unknown services, groundwater, or unsuitable soil. The Contractor is entitled to additional costs and an extension of time for latent conditions.\n\n11. Time for Completion\nAny timeframe provided is an estimate only.\n\n12. Extensions of Time\nThe Contractor is entitled to a reasonable extension of time for delays caused by weather or site conditions; Client delays or instructions; authority or approval delays; variations; supply shortages; or any cause beyond the Contractor's control.\n\n13. Delay Costs and Standdown\nWhere the Works are delayed due to the Client or third parties, the Contractor is entitled to an extension of time and recovery of delay costs. A standdown rate of minimum $3,000 per calendar day applies where the Contractor is unable to proceed due to site access restrictions, delays, or Client-related issues.\n\n14. Practical Completion\nPractical Completion is achieved when the Works are capable of being used for their intended purpose. Minor defects do not prevent Practical Completion and do not justify withholding payment.\n\n15. Defects Liability\nThe Client must notify the Contractor of any defects within seven (7) days of Practical Completion. The Contractor shall rectify confirmed defects within a reasonable timeframe. No liability or warranty applies to Client-supplied materials; plant failure due to weather, maintenance, pests, or external factors; or works carried out at the Client's request in good faith and at no cost. Statutory warranties under NSW legislation apply.\n\n16. Site Access\nThe Client must provide full, safe, and uninterrupted access to the site. Any change to access conditions constitutes a variation.\n\n17. Utilities and Services\nThe Client is responsible for identifying all underground and existing services. The Contractor shall not be liable for damage to services that are not accurately identified.\n\n18. Materials, Title and Risk\nRisk in materials passes to the Client upon delivery to site. Ownership of all materials remains with the Contractor until full payment is received.\n\n19. Insurance\nThe Contractor maintains public liability and workers compensation insurance. Where required under the Home Building Act 1989 (NSW), HBCF insurance shall be provided by the Client at their own cost. The Client is responsible for insuring the property, existing structures, and site conditions.\n\n20. Suspension of Works\nThe Contractor may suspend the Works where payment is overdue; site conditions are unsafe; access is restricted; or approvals or information are delayed. All associated costs, including remobilisation, are payable by the Client.\n\n21. Termination\nThe Contractor may terminate where breach by the Client continues after notice, including non-payment. Upon termination the Contractor is entitled to payment for all Works completed, costs incurred, and loss of profit on remaining Works.\n\n22. No Set-Off\nThe Client shall not withhold, delay, or set off any payment due under this Contract for any reason, including alleged defects.\n\n23. Client Obligations\nThe Client must provide all required approvals and decisions within one (1) calendar day; ensure uninterrupted access; and not interfere with or direct the Contractor's workers.\n\n24. Approvals\nUnless otherwise stated, the Contractor shall obtain required approvals. All authority fees and charges are payable by the Client.\n\n25. Neighbouring Property\nThe Contractor shall not be liable for damage to neighbouring property arising from ground movement, excavation, soil pressure, or pre-existing conditions beyond its control.\n\n26. Limitation of Liability\nTo the maximum extent permitted by law, the Contractor's liability is limited to the Contract Price. The Contractor shall not be liable for indirect or consequential loss.\n\n27. Dispute Resolution\nThe parties shall first attempt to resolve any dispute through good-faith negotiation.\n\n28. Force Majeure\nThe Contractor shall not be liable for delays caused by events beyond its control.\n\n29. Entire Agreement\nThis Contract constitutes the entire agreement between the parties.\n\n30. Acceptance\nPayment of the deposit constitutes full acceptance of this Contract and all Terms & Conditions.\n\n31. Governing Law\nThis Contract is governed by the laws of New South Wales, Australia.`);

  const P = db.prepare(`INSERT INTO price_items (id,code,name,unit,behaviour,basic_spec,basic_sell,standard_spec,standard_sell,premium_spec,premium_sell,notes,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const items = [
    ['PL','Establishment, supervision & insurances','sum','none','Included',1250,'Included',1250,'Included',1250,'Fixed line on every quote'],
    ['EW','General trim, earthworks & cleanup','shift','none','Excavator + operator',1500,'Excavator + operator',1500,'Excavator + operator',1500,''],
    ['GT','Turf supply & install','m2','none','Kikuyu',40,'Sir Walter / Buffalo',45,'Sir Grange',65,''],
    ['GM','Gardenmix & mulch','m2','none','GardenMix + Natural Mulch',75,'Organic Garden Mix + Decorative Mulch',85,'Premium Soil Mixes + Decorative Hardwood Mulch',100,''],
    ['ST','Edging at change of material','m','none','Timber H4',35,'Charcoal brick',45,'Corten steel',55,''],
    ['RW','Retaining wall — up to 1.2m high','m','none','Timber sleeper',475,'Concrete sleeper',600,'Rendered block',910,''],
    ['CP','Concrete driveway','m2','none','Plain concrete',180,'Colour concrete',225,'Exposed aggregate (starting rate)',400,'Off-white cement priced higher per job'],
    ['PW','Weedmat & decorative rock','m2','none','20mm minus rock',60,'River pebbles',80,'White marble',120,''],
    ['FC','Colorbond fence 1.8m','m','remeasurable','Colorbond 1.8m',125,'Colorbond 1.8m',125,'Colorbond 1.8m',125,'Base + priced add-ons (corner posts, lap & cap)'],
    ['FA','Aluminium fence ≤1.2m','m','none','Aluminium tubular',349,'Aluminium tubular',349,'Aluminium tubular',349,''],
    ['FG','Gate — width up to 900mm','ea','none','Colorbond',750,'Aluminium',900,'Custom metal (from)',1500,'Closing panels counted under respective fence type & length'],
    ['FT','Timber sleeper under Colorbond fence','ea','remeasurable','CCL treated sleeper',40,'CCL treated sleeper',40,'CCL treated sleeper',40,'Standard rate $40/ea'],
    ['PC','Stepping stones','ea','none','Charcoal 300×600 / 400×400',40,'Porcelain / Bluestone 400×600',50,'Pavers 600×900',95,''],
    ['RM','Removal of soil/concrete (up to 10t)','load','remeasurable','10t truck load',1500,'10t truck load',1500,'10t truck load',1500,''],
    ['RD','Demolition works','day','none','Excavator + cutting tools',1500,'Excavator + cutting tools',1500,'Excavator + cutting tools',1500,'Disposal under Scope 2 · No allowance for ACM (asbestos)'],
    ['TR','Plants / shrubs & trees','lump','none','Site specific',0,'Site specific',0,'Site specific',0,'Priced per quote'],
    ['AL','Letterbox','ea','allowance','Standard (allowance $200)',400,'Mid-range (allowance $300)',500,'Designer (allowance $400)',600,''],
    ['AC','Clothesline','ea','none','Wall mounted',400,'16m post mounted',500,'25m post mounted',600,''],
    ['SC2','Disposal of construction waste','m3','remeasurable','At cost + 15%',350,'At cost + 15%',350,'At cost + 15%',350,'Scope 2 — invoice-substantiated'],
  ];
  items.forEach((r,i)=>P.run(uid(),r[0],r[1],r[2],r[3],r[4],r[5],r[6],r[7],r[8],r[9],r[10],i));

  const S = db.prepare('INSERT INTO surcharges (id,name,trigger_note,kind,rate,sort_order) VALUES (?,?,?,?,?,?)');
  [
    ['Difficult access','No machinery access to work area / hand-carry materials','percent',10],
    ['Steep slope','Site slope over ~15°','percent',15],
    ['Narrow side access','Access under 1200mm clearance','fixed',750],
    ['Rear yard — no vehicle access','All materials through the house / over fence','fixed',1200],
    ['Double storey / scaffold zone','Works under scaffold or restricted drop zones','fixed',500],
  ].forEach((r,i)=>S.run(uid(),r[0],r[1],r[2],r[3],i));

  const C = db.prepare('INSERT INTO checklist_template (id,sort_order,category,label,critical) VALUES (?,?,?,?,?)');
  [
    ['Engineering & Approvals',"Structural engineer's design/detail obtained and on file",1],
    ['Engineering & Approvals',"Wall height/spec confirmed against engineer's certified drawing",1],
    ['Engineering & Approvals','Council/DA approval sighted where required',1],
    ['Site & Services','Dial Before You Dig / underground services locate completed',1],
    ['Site & Services','Stormwater, sewer, power & comms marked on site',1],
    ['Site & Services','Access, surcharges & standdown terms confirmed with client',0],
    ['Excavation & Footings',"Footing depth matches engineer's detail",1],
    ['Excavation & Footings','Rock / tree roots logged for variation quote',0],
    ['Drainage','Ag line (socked) installed to rear of wall',1],
    ['Drainage','Free-draining backfill placed to full wall height',0],
    ['Drainage','Ag line discharge point confirmed',1],
    ['Structural Materials','Concrete strength / mix matches spec',1],
    ['Finish & Handover','Photos taken of footings and drainage before backfill (warranty record)',1],
    ['Finish & Handover','Client walkthrough completed and sign-off obtained',0],
  ].forEach((r,i)=>C.run(uid(),i,r[0],r[1],r[2]));

  settingSet('seeded_v2','1');
}

module.exports = { db, settingGet, settingSet };
