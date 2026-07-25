'use strict';
/* ============================================================
   GESTION CUAUTLA  -  servidor unico (Express + Postgres)
   - Carga semanal del listado (xlsx) filtrado por REGION
   - Acceso por zona (cada zona ve solo lo suyo) + supervisor (ve todo)
   - Gestion con evidencia (foto) + ubicacion (GPS)
   - Exporta archivo general de cuentas gestionadas (xlsx)
   No es cobrapro: sin multi-tenant, sin comisiones, sin reporteria.
   ============================================================ */

const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Region que atiende esta instancia. Se usa para filtrar el listado semanal.
const REGION = (process.env.REGION || 'CUAUTLA').toUpperCase();

// Secretos. En Render fijar SIEMPRE JWT_SECRET (si no, cae a default inseguro).
const JWT_SECRET = process.env.JWT_SECRET || 'cuautla_dev_cambiame';
if (JWT_SECRET === 'cuautla_dev_cambiame') {
  console.warn('[SEGURIDAD] JWT_SECRET no esta fijado en el entorno. Fijalo en Render.');
}
// Password inicial para todos los usuarios sembrados (cambiar despues).
const PASS_ZONA = process.env.PASS_ZONA || 'cuautla2026';
const PASS_SUPER = process.env.PASS_SUPER || 'super2026';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false : { rejectUnauthorized: false },
  max: 8,
  keepAlive: true,
  idleTimeoutMillis: 30000,
});
pool.on('error', (e) => console.error('[pg pool error]', e.message));

// Reintento simple ante cortes momentaneos de conexion.
async function q(text, params) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await pool.query(text, params); }
    catch (e) {
      last = e;
      if (!/terminat|ECONNRESET|timeout|Connection/i.test(e.message)) throw e;
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw last;
}

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

/* ---------------------- ESQUEMA ---------------------- */
async function initDB() {
  await q(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      usuario TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      rol TEXT NOT NULL,              -- 'zona' | 'super'
      zona TEXT,                      -- nombre exacto de zona si rol='zona'
      nombre TEXT,
      creado TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS clientes (
      contrato TEXT PRIMARY KEY,
      no_cliente TEXT,
      nombre TEXT,
      agencia TEXT,
      zona TEXT,
      unidad TEXT,
      grado TEXT,                     -- Vigente | Vencida | Mora
      monto NUMERIC,
      total_pagar NUMERIC,
      tarifa NUMERIC,
      saldo NUMERIC,
      exigible NUMERIC,
      atraso NUMERIC,
      sem_atraso NUMERIC,
      liquidacion NUMERIC,
      ufechapago DATE,
      plazo TEXT,
      producto TEXT,
      tel1 TEXT, tel2 TEXT, tel3 TEXT,
      domicilio TEXT,
      aval TEXT,
      dom_aval TEXT,
      tel_aval1 TEXT, tel_aval2 TEXT, tel_aval3 TEXT,
      semana INTEGER,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      geo_fuente TEXT,               -- 'gps' (exacta, de gestion) | 'geocode' (por direccion)
      activo BOOLEAN DEFAULT true,
      actualizado TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_cli_zona ON clientes(zona);
    CREATE INDEX IF NOT EXISTS idx_cli_grado ON clientes(grado);
    CREATE TABLE IF NOT EXISTS gestiones (
      id BIGSERIAL PRIMARY KEY,
      contrato TEXT REFERENCES clientes(contrato),
      usuario TEXT,
      zona TEXT,
      resultado TEXT,
      notas TEXT,
      monto_prometido NUMERIC,
      fecha_promesa DATE,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      semana INTEGER,
      creado TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ges_contrato ON gestiones(contrato);
    CREATE INDEX IF NOT EXISTS idx_ges_zona ON gestiones(zona);
    CREATE TABLE IF NOT EXISTS gestion_foto (
      id BIGSERIAL PRIMARY KEY,
      gestion_id BIGINT REFERENCES gestiones(id) ON DELETE CASCADE,
      datos TEXT,
      bytes INTEGER
    );
    CREATE TABLE IF NOT EXISTS meta (clave TEXT PRIMARY KEY, valor TEXT);
  `);
  // Columnas de ubicacion para bases que ya existian antes de esta version.
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`);
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION`);
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS geo_fuente TEXT`);
  await q(`CREATE TABLE IF NOT EXISTS geo_cache (clave TEXT PRIMARY KEY, lat DOUBLE PRECISION, lng DOUBLE PRECISION, creado TIMESTAMPTZ DEFAULT now())`);
}

// Siembra usuarios: supervisor + una cuenta por cada zona que exista en clientes.
async function sembrarUsuarios() {
  const sup = await q(`SELECT 1 FROM usuarios WHERE usuario='super'`);
  if (!sup.rowCount) {
    const h = await bcrypt.hash(PASS_SUPER, 10);
    await q(`INSERT INTO usuarios(usuario,pass_hash,rol,nombre) VALUES('super',$1,'super','Supervisor')`, [h]);
    console.log('[seed] usuario supervisor: super');
  }
  // Crea usuario por cada zona presente que aun no tenga cuenta.
  const zonas = await q(`SELECT DISTINCT zona FROM clientes WHERE zona IS NOT NULL ORDER BY zona`);
  for (const { zona } of zonas.rows) {
    const user = usuarioDeZona(zona);
    const ex = await q(`SELECT 1 FROM usuarios WHERE usuario=$1`, [user]);
    if (!ex.rowCount) {
      const h = await bcrypt.hash(PASS_ZONA, 10);
      await q(`INSERT INTO usuarios(usuario,pass_hash,rol,zona,nombre) VALUES($1,$2,'zona',$3,$4)`,
        [user, h, zona, zona]);
      console.log('[seed] usuario zona:', user, '->', zona);
    }
  }
}

// "ZONA CUAUTLA 03" -> "cuautla03"
function usuarioDeZona(z) {
  const m = String(z).match(/CUAUTLA\s*0*(\d+)/i);
  if (m) return 'cuautla' + String(m[1]).padStart(2, '0');
  return String(z).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);
}

/* ---------------------- AUTH ---------------------- */
function firmar(u) {
  return jwt.sign({ id: u.id, usuario: u.usuario, rol: u.rol, zona: u.zona }, JWT_SECRET, { expiresIn: '30d' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : (req.query.t || '');
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'no autorizado' }); }
}
function soloSuper(req, res, next) {
  if (req.user.rol !== 'super') return res.status(403).json({ error: 'solo supervisor' });
  next();
}

app.post('/api/login', async (req, res) => {
  try {
    const { usuario, password } = req.body || {};
    const r = await q(`SELECT * FROM usuarios WHERE usuario=$1`, [String(usuario || '').trim().toLowerCase()]);
    if (!r.rowCount) return res.status(401).json({ error: 'usuario o contrasena incorrectos' });
    const u = r.rows[0];
    const ok = await bcrypt.compare(String(password || ''), u.pass_hash);
    if (!ok) return res.status(401).json({ error: 'usuario o contrasena incorrectos' });
    res.json({ token: firmar(u), rol: u.rol, zona: u.zona, nombre: u.nombre, usuario: u.usuario });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Cambio de contrasena del propio usuario.
app.post('/api/password', auth, async (req, res) => {
  try {
    const { actual, nueva } = req.body || {};
    const r = await q(`SELECT * FROM usuarios WHERE id=$1`, [req.user.id]);
    const u = r.rows[0];
    if (!(await bcrypt.compare(String(actual || ''), u.pass_hash)))
      return res.status(400).json({ error: 'contrasena actual incorrecta' });
    if (String(nueva || '').length < 4) return res.status(400).json({ error: 'minimo 4 caracteres' });
    await q(`UPDATE usuarios SET pass_hash=$1 WHERE id=$2`, [await bcrypt.hash(String(nueva), 10), u.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------------- HELPERS DE LECTURA XLSX ---------------------- */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, '').replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? null : n;
}
function txt(v) { return (v === null || v === undefined) ? null : String(v).trim(); }
function fecha(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') { // serial de Excel
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/* ---------------------- IMPORTAR LISTADO SEMANAL (solo super) ---------------------- */
app.post('/api/importar', auth, soloSuper, upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'falta el archivo' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const gradoDeHoja = { vigente: 'Vigente', vencida: 'Vencida', mora: 'Mora' };

    const registros = [];
    for (const hoja of wb.SheetNames) {
      const grado = gradoDeHoja[hoja.trim().toLowerCase()];
      if (!grado) continue; // ignora hojas que no sean los 3 grados
      const filas = XLSX.utils.sheet_to_json(wb.Sheets[hoja], { defval: null, raw: true });
      for (const f of filas) {
        const zona = txt(f['Zona']) || '';
        const unidad = txt(f['Unidad']) || '';
        if (!(zona.toUpperCase().includes(REGION) || unidad.toUpperCase().includes(REGION))) continue;
        const contrato = txt(f['Contrato']);
        if (!contrato) continue;
        registros.push({
          contrato, grado, zona, unidad,
          no_cliente: txt(f['No_Cliente']),
          nombre: txt(f['Cliente']),
          agencia: txt(f['Agencia']),
          monto: num(f['Monto']),
          total_pagar: num(f['TotalPagar']),
          tarifa: num(f['Tarifa']),
          saldo: num(f['Saldo']),
          exigible: num(f['Exigible']),
          atraso: num(f['Atraso']),
          sem_atraso: num(f['SemanasAtraso']),
          liquidacion: num(f['Liquidacion']),
          ufechapago: fecha(f['UFechaPago']),
          plazo: txt(f['Plazo']),
          producto: txt(f['Producto']),
          tel1: txt(f['Tel1']), tel2: txt(f['Tel2']), tel3: txt(f['Tel3']),
          domicilio: txt(f['DomicilioCliente']),
          aval: txt(f['Aval']),
          dom_aval: txt(f['DomicilioAval']),
          tel_aval1: txt(f['TelAval1']), tel_aval2: txt(f['TelAval2']), tel_aval3: txt(f['TelAval3']),
          semana: num(f['Semana']),
        });
      }
    }
    if (!registros.length)
      return res.status(400).json({ error: `no se encontraron clientes de la region ${REGION} en el archivo` });

    const contratosArchivo = registros.map(r => r.contrato);
    const client = await pool.connect();
    let insert = 0, update = 0;
    try {
      await client.query('BEGIN');
      // Marca inactivos los que ya no aparecen (liquidados/reasignados), sin borrar gestiones.
      await client.query(
        `UPDATE clientes SET activo=false WHERE contrato <> ALL($1::text[]) AND (zona ILIKE '%'||$2||'%' OR unidad ILIKE '%'||$2||'%')`,
        [contratosArchivo, REGION]
      );
      for (const r of registros) {
        const ex = await client.query('SELECT 1 FROM clientes WHERE contrato=$1', [r.contrato]);
        if (ex.rowCount) update++; else insert++;
        await client.query(`
          INSERT INTO clientes (contrato,no_cliente,nombre,agencia,zona,unidad,grado,monto,total_pagar,tarifa,
            saldo,exigible,atraso,sem_atraso,liquidacion,ufechapago,plazo,producto,tel1,tel2,tel3,domicilio,
            aval,dom_aval,tel_aval1,tel_aval2,tel_aval3,semana,activo,actualizado)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,true,now())
          ON CONFLICT (contrato) DO UPDATE SET
            no_cliente=EXCLUDED.no_cliente, nombre=EXCLUDED.nombre, agencia=EXCLUDED.agencia,
            zona=EXCLUDED.zona, unidad=EXCLUDED.unidad, grado=EXCLUDED.grado, monto=EXCLUDED.monto,
            total_pagar=EXCLUDED.total_pagar, tarifa=EXCLUDED.tarifa, saldo=EXCLUDED.saldo,
            exigible=EXCLUDED.exigible, atraso=EXCLUDED.atraso, sem_atraso=EXCLUDED.sem_atraso,
            liquidacion=EXCLUDED.liquidacion, ufechapago=EXCLUDED.ufechapago, plazo=EXCLUDED.plazo,
            producto=EXCLUDED.producto, tel1=EXCLUDED.tel1, tel2=EXCLUDED.tel2, tel3=EXCLUDED.tel3,
            domicilio=EXCLUDED.domicilio, aval=EXCLUDED.aval, dom_aval=EXCLUDED.dom_aval,
            tel_aval1=EXCLUDED.tel_aval1, tel_aval2=EXCLUDED.tel_aval2, tel_aval3=EXCLUDED.tel_aval3,
            semana=EXCLUDED.semana, activo=true, actualizado=now()
        `, [r.contrato, r.no_cliente, r.nombre, r.agencia, r.zona, r.unidad, r.grado, r.monto, r.total_pagar,
            r.tarifa, r.saldo, r.exigible, r.atraso, r.sem_atraso, r.liquidacion, r.ufechapago, r.plazo,
            r.producto, r.tel1, r.tel2, r.tel3, r.domicilio, r.aval, r.dom_aval, r.tel_aval1, r.tel_aval2,
            r.tel_aval3, r.semana]);
      }
      const semanaArchivo = registros.find(r => r.semana != null)?.semana || null;
      await client.query(`INSERT INTO meta(clave,valor) VALUES('ultima_importacion',$1)
        ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor`,
        [JSON.stringify({ fecha: new Date().toISOString(), total: registros.length, semana: semanaArchivo })]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }

    await sembrarUsuarios(); // crea usuarios de zonas nuevas si aparecieron
    res.json({ ok: true, total: registros.length, nuevos: insert, actualizados: update });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

/* ---------------------- LISTA DE ZONAS (super) ---------------------- */
app.get('/api/zonas', auth, async (req, res) => {
  try {
    const r = await q(`
      SELECT c.zona,
             COUNT(*) FILTER (WHERE c.activo) AS clientes,
             COUNT(*) FILTER (WHERE c.activo AND c.grado='Vigente') AS vigente,
             COUNT(*) FILTER (WHERE c.activo AND c.grado='Vencida') AS vencida,
             COUNT(*) FILTER (WHERE c.activo AND c.grado='Mora') AS mora,
             COUNT(DISTINCT g.contrato) AS gestionados
      FROM clientes c
      LEFT JOIN gestiones g ON g.contrato=c.contrato
      WHERE ($1::text IS NULL OR c.zona=$1)
      GROUP BY c.zona ORDER BY c.zona`,
      [req.user.rol === 'zona' ? req.user.zona : null]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------------- CLIENTES ---------------------- */
app.get('/api/clientes', auth, async (req, res) => {
  try {
    const zonaReq = req.user.rol === 'zona' ? req.user.zona : (req.query.zona || null);
    const grado = req.query.grado || null;   // Vigente|Vencida|Mora
    const buscar = (req.query.buscar || '').trim();
    const soloPend = req.query.pendientes === '1'; // sin gestion esta semana
    const params = [];
    let where = 'c.activo=true';
    if (zonaReq) { params.push(zonaReq); where += ` AND c.zona=$${params.length}`; }
    if (grado) { params.push(grado); where += ` AND c.grado=$${params.length}`; }
    if (buscar) {
      params.push('%' + buscar + '%');
      where += ` AND (c.nombre ILIKE $${params.length} OR c.contrato ILIKE $${params.length} OR c.no_cliente ILIKE $${params.length} OR c.domicilio ILIKE $${params.length})`;
    }
    const r = await q(`
      SELECT c.contrato,c.no_cliente,c.nombre,c.zona,c.grado,c.saldo,c.exigible,c.atraso,c.sem_atraso,
             c.tel1,c.tel2,c.tel3,c.domicilio,c.producto,c.ufechapago,
             (SELECT COUNT(*) FROM gestiones g WHERE g.contrato=c.contrato) AS n_gestiones,
             (SELECT max(creado) FROM gestiones g WHERE g.contrato=c.contrato) AS ult_gestion,
             (SELECT resultado FROM gestiones g WHERE g.contrato=c.contrato ORDER BY creado DESC LIMIT 1) AS ult_resultado
      FROM clientes c
      WHERE ${where}
      ${soloPend ? 'AND NOT EXISTS (SELECT 1 FROM gestiones g WHERE g.contrato=c.contrato AND g.creado::date=CURRENT_DATE)' : ''}
      ORDER BY c.grado DESC, c.nombre
      LIMIT 1500`, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Detalle de un cliente + historial de gestiones (sin las fotos completas, solo ids).
app.get('/api/cliente/:contrato', auth, async (req, res) => {
  try {
    const c = await q('SELECT * FROM clientes WHERE contrato=$1', [req.params.contrato]);
    if (!c.rowCount) return res.status(404).json({ error: 'no existe' });
    if (req.user.rol === 'zona' && c.rows[0].zona !== req.user.zona)
      return res.status(403).json({ error: 'fuera de tu zona' });
    const g = await q(`
      SELECT g.*, (SELECT json_agg(f.id) FROM gestion_foto f WHERE f.gestion_id=g.id) AS fotos
      FROM gestiones g WHERE g.contrato=$1 ORDER BY g.creado DESC`, [req.params.contrato]);
    res.json({ cliente: c.rows[0], gestiones: g.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------------- REGISTRAR GESTION ---------------------- */
app.post('/api/gestion', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { contrato, resultado, notas, monto_prometido, fecha_promesa, lat, lng, fotos } = req.body || {};
    if (!contrato || !resultado) return res.status(400).json({ error: 'contrato y resultado obligatorios' });
    const c = await client.query('SELECT zona,semana FROM clientes WHERE contrato=$1', [contrato]);
    if (!c.rowCount) return res.status(404).json({ error: 'cliente no existe' });
    if (req.user.rol === 'zona' && c.rows[0].zona !== req.user.zona)
      return res.status(403).json({ error: 'fuera de tu zona' });

    await client.query('BEGIN');
    const g = await client.query(`
      INSERT INTO gestiones (contrato,usuario,zona,resultado,notas,monto_prometido,fecha_promesa,lat,lng,semana)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [contrato, req.user.usuario, c.rows[0].zona, resultado, txt(notas), num(monto_prometido),
       fecha_promesa || null, lat != null ? Number(lat) : null, lng != null ? Number(lng) : null,
       c.rows[0].semana]);
    const gid = g.rows[0].id;
    const arr = Array.isArray(fotos) ? fotos.slice(0, 4) : [];
    for (const dataUrl of arr) {
      if (!dataUrl || typeof dataUrl !== 'string') continue;
      await client.query('INSERT INTO gestion_foto(gestion_id,datos,bytes) VALUES($1,$2,$3)',
        [gid, dataUrl, dataUrl.length]);
    }
    // El GPS de la visita es la ubicacion exacta: pisa cualquier geocodificacion.
    if (lat != null && lng != null) {
      await client.query(
        `UPDATE clientes SET lat=$1, lng=$2, geo_fuente='gps' WHERE contrato=$3`,
        [Number(lat), Number(lng), contrato]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, id: gid });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// Servir una foto por id (para <img src>). Acepta token por query (?t=).
app.get('/api/foto/:id', auth, async (req, res) => {
  try {
    const r = await q('SELECT datos FROM gestion_foto WHERE id=$1', [req.params.id]);
    if (!r.rowCount) return res.status(404).end();
    const d = r.rows[0].datos;
    const m = /^data:(image\/\w+);base64,(.*)$/s.exec(d);
    if (!m) { res.type('text/plain').send(d); return; }
    res.type(m[1]).send(Buffer.from(m[2], 'base64'));
  } catch (e) { res.status(500).end(); }
});

/* ---------------------- MAPA ---------------------- */
// Clientes con ubicacion conocida (gps o geocode). Zona ve lo suyo; super ve todo o filtra por zona.
app.get('/api/mapa', auth, async (req, res) => {
  try {
    const zonaReq = req.user.rol === 'zona' ? req.user.zona : (req.query.zona || null);
    const grado = req.query.grado || null;
    const params = [];
    let where = 'c.activo=true AND c.lat IS NOT NULL AND c.lng IS NOT NULL';
    if (zonaReq) { params.push(zonaReq); where += ` AND c.zona=$${params.length}`; }
    if (grado) { params.push(grado); where += ` AND c.grado=$${params.length}`; }
    const r = await q(`
      SELECT c.contrato,c.nombre,c.zona,c.grado,c.saldo,c.exigible,c.domicilio,c.lat,c.lng,c.geo_fuente,
             EXISTS(SELECT 1 FROM gestiones g WHERE g.contrato=c.contrato) AS gestionado
      FROM clientes c WHERE ${where} ORDER BY c.grado DESC LIMIT 3000`, params);
    // Conteo de los que aun no tienen ubicacion (para avisar en el panel)
    const sinP = []; let sinW = 'c.activo=true AND (c.lat IS NULL OR c.lng IS NULL)';
    if (zonaReq) { sinP.push(zonaReq); sinW += ` AND c.zona=$${sinP.length}`; }
    const sin = await q(`SELECT COUNT(*)::int AS n FROM clientes c WHERE ${sinW}`, sinP);
    res.json({ puntos: r.rows, sin_ubicacion: sin.rows[0].n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Parte el domicilio: "CALLE #x, Int:y, COLONIA, MUNICIPIO, ESTADO" -> {colonia, municipio, estado}
function parseDom(dom) {
  if (!dom) return null;
  const p = String(dom).split(',').map(s => s.trim()).filter(Boolean);
  if (p.length < 2) return null;
  const estado = p[p.length - 1];
  const municipio = p[p.length - 2];
  let colonia = p.length >= 3 ? p[p.length - 3] : null;
  if (colonia) colonia = colonia.replace(/#\s*S\/?N/ig, '').replace(/Int:\s*[^,]*/ig, '').replace(/\s{2,}/g, ' ').trim() || null;
  return { colonia, municipio, estado };
}
// Caja generosa: Morelos + sur de Edomex + orilla de Puebla/Tlaxcala. Fuera de aqui = mala coincidencia.
const GEO_BOX = { latMin: 17.8, latMax: 19.8, lngMin: -99.8, lngMax: -97.6 };
function dentroDeCaja(lat, lng) {
  return lat >= GEO_BOX.latMin && lat <= GEO_BOX.latMax && lng >= GEO_BOX.lngMin && lng <= GEO_BOX.lngMax;
}
// viewbox para sesgar Nominatim hacia la region (no estricto): izq,arriba,der,abajo
const VIEWBOX = `${GEO_BOX.lngMin},${GEO_BOX.latMax},${GEO_BOX.lngMax},${GEO_BOX.latMin}`;
async function nominatim(query) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=mx'
    + '&viewbox=' + encodeURIComponent(VIEWBOX) + '&q=' + encodeURIComponent(query);
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'GestionCuautla/1.0 (cobranza interna)' }, signal: ctrl.signal });
    if (r.status === 429 || r.status === 403) { const e = new Error('limite'); e.limite = true; throw e; }
    if (!r.ok) return null;
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) return null;
    const lat = +parseFloat(j[0].lat).toFixed(6), lng = +parseFloat(j[0].lon).toFixed(6);
    return dentroDeCaja(lat, lng) ? { lat, lng } : null;
  } finally { clearTimeout(to); }
}
// Geocodifica una direccion: intenta colonia+municipio+estado; si falla, cae a municipio+estado.
async function geocodDir(d) {
  const est = d.estado || 'Morelos';
  const intentos = [];
  if (d.colonia) intentos.push(`${d.colonia}, ${d.municipio}, ${est}, Mexico`);
  intentos.push(`${d.municipio}, ${est}, Mexico`); // respaldo: al menos el municipio correcto
  for (let i = 0; i < intentos.length; i++) {
    const r = await nominatim(intentos[i]); // puede lanzar {limite}
    if (r) return { ...r, nivel: (d.colonia && i === 0) ? 'colonia' : 'municipio' };
    await new Promise(t => setTimeout(t, 1100)); // 1/seg
  }
  return null;
}
function jitter(v) { return +(v + (Math.random() - 0.5) * 0.0016).toFixed(6); } // ~±90 m

// Estado del proceso (en memoria; el avance real vive en geo_cache).
const GEO = { corriendo: false, fase: 'inactivo', total: 0, hechos: 0, ubicados: 0, colonias: 0, colHechas: 0, error: null };

async function correrGeo() {
  if (GEO.corriendo) return;
  GEO.corriendo = true; GEO.fase = 'preparando'; GEO.error = null; GEO.hechos = 0; GEO.ubicados = 0;
  try {
    const cli = await q(`
      SELECT contrato, domicilio FROM clientes
      WHERE activo=true AND lat IS NULL AND (geo_fuente IS DISTINCT FROM 'gps') AND domicilio IS NOT NULL`);
    // Agrupa por lugar (colonia|municipio|estado) para geocodificar una sola vez cada uno.
    const porLugar = new Map();
    for (const c of cli.rows) {
      const d = parseDom(c.domicilio);
      if (!d) continue;
      const k = `${(d.colonia || '').toUpperCase()}|${(d.municipio || '').toUpperCase()}|${(d.estado || '').toUpperCase()}`;
      if (!porLugar.has(k)) porLugar.set(k, { d, contratos: [] });
      porLugar.get(k).contratos.push(c.contrato);
    }
    GEO.total = cli.rows.length; GEO.colonias = porLugar.size; GEO.colHechas = 0; GEO.fase = 'ubicando';

    for (const [k, v] of porLugar) {
      if (!GEO.corriendo) { GEO.fase = 'detenido'; break; }
      let coord = null;
      const cach = await q('SELECT lat,lng FROM geo_cache WHERE clave=$1', [k]);
      if (cach.rowCount) coord = (cach.rows[0].lat != null) ? cach.rows[0] : null;
      else {
        try {
          coord = await geocodDir(v.d);
          await q(`INSERT INTO geo_cache(clave,lat,lng) VALUES($1,$2,$3)
                   ON CONFLICT(clave) DO UPDATE SET lat=EXCLUDED.lat,lng=EXCLUDED.lng`,
            [k, coord ? coord.lat : null, coord ? coord.lng : null]);
        } catch (e) {
          if (e.limite) { GEO.fase = 'pausado_limite'; GEO.error = 'El servicio de mapas limitó las consultas. Reintenta en unos minutos.'; break; }
          coord = null;
        }
      }
      if (coord) {
        for (const contrato of v.contratos) {
          await q(`UPDATE clientes SET lat=$1,lng=$2,geo_fuente='geocode'
                   WHERE contrato=$3 AND (geo_fuente IS DISTINCT FROM 'gps')`,
            [jitter(coord.lat), jitter(coord.lng), contrato]);
          GEO.ubicados++;
        }
      } else {
        for (const contrato of v.contratos)
          await q(`UPDATE clientes SET geo_fuente='no_geo' WHERE contrato=$1 AND geo_fuente IS NULL`, [contrato]);
      }
      GEO.hechos += v.contratos.length; GEO.colHechas++;
    }
    if (GEO.fase === 'ubicando') GEO.fase = 'terminado';
  } catch (e) { GEO.fase = 'error'; GEO.error = e.message; console.error('[geo]', e); }
  finally { GEO.corriendo = false; }
}

app.post('/api/geo/iniciar', auth, soloSuper, async (req, res) => {
  if (GEO.corriendo) return res.json({ ok: true, ya: true, ...GEO });
  correrGeo(); // no await: corre en segundo plano
  res.json({ ok: true, iniciado: true });
});
app.post('/api/geo/detener', auth, soloSuper, (req, res) => { GEO.corriendo = false; res.json({ ok: true }); });
app.get('/api/geo/estado', auth, soloSuper, async (req, res) => {
  const sin = await q(`SELECT COUNT(*)::int AS n FROM clientes WHERE activo=true AND lat IS NULL AND domicilio IS NOT NULL`);
  const con = await q(`SELECT COUNT(*)::int AS n FROM clientes WHERE activo=true AND lat IS NOT NULL`);
  res.json({ ...GEO, sin_ubicacion: sin.rows[0].n, con_ubicacion: con.rows[0].n });
});

/* ---------------------- EXPORTAR ARCHIVO GENERAL (super) ---------------------- */
app.get('/api/exportar', auth, soloSuper, async (req, res) => {
  try {
    const r = await q(`
      SELECT g.creado, g.zona, g.usuario, c.contrato, c.no_cliente, c.nombre, c.grado,
             c.saldo, c.exigible, c.atraso, c.domicilio, c.tel1, c.tel2,
             g.resultado, g.notas, g.monto_prometido, g.fecha_promesa, g.lat, g.lng,
             (SELECT COUNT(*) FROM gestion_foto f WHERE f.gestion_id=g.id) AS fotos
      FROM gestiones g JOIN clientes c ON c.contrato=g.contrato
      ORDER BY g.creado DESC`);
    const filas = r.rows.map(x => ({
      Fecha: x.creado ? new Date(x.creado).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }) : '',
      Zona: x.zona, Gestor: x.usuario, Contrato: x.contrato, No_Cliente: x.no_cliente,
      Cliente: x.nombre, Grado: x.grado, Saldo: x.saldo, Exigible: x.exigible, Atraso: x.atraso,
      Resultado: x.resultado, Notas: x.notas || '',
      MontoPrometido: x.monto_prometido || '', FechaPromesa: x.fecha_promesa || '',
      Domicilio: x.domicilio || '', Tel1: x.tel1 || '', Tel2: x.tel2 || '',
      Ubicacion: (x.lat != null && x.lng != null) ? `${x.lat},${x.lng}` : '',
      MapsURL: (x.lat != null && x.lng != null) ? `https://maps.google.com/?q=${x.lat},${x.lng}` : '',
      Fotos: x.fotos,
    }));
    const ws = XLSX.utils.json_to_sheet(filas);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Gestionadas');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fn = `cuentas_gestionadas_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

/* ---------------------- RESUMEN / SALUD ---------------------- */
app.get('/api/resumen', auth, async (req, res) => {
  try {
    const zonaReq = req.user.rol === 'zona' ? req.user.zona : null;
    const p = zonaReq ? [zonaReq] : [];
    const w = zonaReq ? 'AND c.zona=$1' : '';
    const r = await q(`
      SELECT COUNT(*) FILTER (WHERE c.activo) AS clientes,
             COUNT(DISTINCT g.contrato) AS gestionados,
             COUNT(DISTINCT g.contrato) FILTER (WHERE g.creado::date=CURRENT_DATE) AS hoy
      FROM clientes c LEFT JOIN gestiones g ON g.contrato=c.contrato
      WHERE 1=1 ${w}`, p);
    const meta = await q(`SELECT valor FROM meta WHERE clave='ultima_importacion'`);
    res.json({ ...r.rows[0], region: REGION,
      ultima_importacion: meta.rowCount ? JSON.parse(meta.rows[0].valor) : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', async (req, res) => {
  try { await q('SELECT 1'); res.json({ ok: true, region: REGION }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));

(async () => {
  try {
    await initDB();
    await sembrarUsuarios();
    app.listen(PORT, () => console.log(`CUAUTLA (region ${REGION}) escuchando en ${PORT}`));
  } catch (e) { console.error('Fallo al iniciar:', e); process.exit(1); }
})();
