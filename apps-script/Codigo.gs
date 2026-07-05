/**
 * Backend Dinastel — Cotizador solar
 * Pegar este código completo en script.google.com (Apps Script).
 * Configurar en "Propiedades del script": NOTION_TOKEN, NOTION_DB_ID
 */

// ── Constantes de cálculo (CONFIDENCIAL — nunca exponer al cliente) ──
var TARIFA_REF     = 850;       // $/kWh, tarifa de referencia Valle del Cauca
var HSP            = 4;         // horas sol pico
var FACTOR_DISENO  = 1.3;       // sobredimensionamiento
var PRECIO_KWP_MIN = 3700000;
var PRECIO_KWP_MAX = 4500000;
var PORC_AHORRO    = 0.85;      // ahorro estimado sobre la factura

function doPost(e) {
  var out;
  try {
    var data = JSON.parse(e.postData.contents);
    var origen = data.origen || 'Cotizador';

    if (origen === 'Cotizador') {
      out = handleCotizador(data);
    } else {
      out = { ok: false, error: 'origen_no_soportado' };
    }
  } catch (err) {
    console.error('doPost error: ' + err);
    out = { ok: false };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleCotizador(data) {
  // 1. Validar
  var nombre       = String(data.nombre || '').trim();
  var whatsapp     = String(data.whatsapp || '').replace(/\D/g, '');
  var email        = String(data.email || '').trim();
  var ciudad       = String(data.ciudad || '').trim();
  var uso          = String(data.uso || '').trim();
  var factura      = Number(data.factura) || 0;
  var consumoInput = data.consumo ? Number(data.consumo) : null;

  if (!nombre || whatsapp.length !== 10 || !email || !ciudad || !uso || factura <= 0) {
    return { ok: false, error: 'datos_invalidos' };
  }

  // 2. Calcular
  var consumo_kwh   = consumoInput || (factura / TARIFA_REF);
  var kwp            = Math.round(((consumo_kwh / 30 / HSP) * FACTOR_DISENO) * 10) / 10;
  var inversion_min  = Math.round(kwp * PRECIO_KWP_MIN);
  var inversion_max  = Math.round(kwp * PRECIO_KWP_MAX);
  var ahorro_mes     = Math.round(factura * PORC_AHORRO);
  var retorno_anios  = Math.round((((inversion_min + inversion_max) / 2) / ahorro_mes / 12) * 10) / 10;

  var resultado = {
    ok: true, kwp: kwp, inversion_min: inversion_min, inversion_max: inversion_max,
    ahorro_mes: ahorro_mes, retorno_anios: retorno_anios
  };

  // 3. Guardar lead en Notion (si falla, no interrumpe el flujo)
  try {
    guardarLeadNotion({
      nombre: nombre, whatsapp: whatsapp, email: email, ciudad: ciudad, uso: uso,
      factura: factura, consumo_kwh: Math.round(consumo_kwh),
      kwp: kwp, inversion_min: inversion_min, inversion_max: inversion_max,
      origen: 'Cotizador'
    });
  } catch (err) {
    console.error('Error guardando en Notion: ' + err);
  }

  // 4. Enviar informe por correo (si falla, igual respondemos al usuario)
  try {
    enviarInformeCorreo(email, nombre, resultado, { ciudad: ciudad, uso: uso, factura: factura });
  } catch (err) {
    console.error('Error enviando correo: ' + err);
  }

  // 5. Responder a la página
  return resultado;
}

function guardarLeadNotion(lead) {
  var token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  var dbId  = PropertiesService.getScriptProperties().getProperty('NOTION_DB_ID');
  if (!token || !dbId) throw new Error('Notion no configurado (faltan NOTION_TOKEN / NOTION_DB_ID)');

  var inversionTexto = '$' + lead.inversion_min.toLocaleString('es-CO') + ' - $' + lead.inversion_max.toLocaleString('es-CO');

  var payload = {
    parent: { database_id: dbId },
    properties: {
      'Nombre':             { title: [{ text: { content: lead.nombre } }] },
      'WhatsApp':           { phone_number: '+57' + lead.whatsapp },
      'Correo':             { email: lead.email },
      'Ciudad':             { select: { name: lead.ciudad } },
      'Tipo de uso':        { select: { name: lead.uso } },
      'Factura mensual':    { number: lead.factura },
      'Consumo kWh':        { number: lead.consumo_kwh },
      'kWp estimado':       { number: lead.kwp },
      'Inversión estimada': { rich_text: [{ text: { content: inversionTexto } }] },
      'Origen':             { select: { name: lead.origen } },
      'Etapa':              { select: { name: 'Lead' } }
    }
  };

  var res = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() >= 300) {
    throw new Error('Notion API error: ' + res.getContentText());
  }
}

function enviarInformeCorreo(destinatario, nombre, resultado, datos) {
  var asunto = 'Tu cotización solar estimada — Dinastel';
  var cuerpo = ''
    + '<div style="font-family:Arial,sans-serif;color:#222;line-height:1.6;max-width:560px;margin:0 auto">'
    + '<h2 style="color:#C89010">Hola ' + nombre + ',</h2>'
    + '<p>Gracias por cotizar tu sistema solar con Dinastel. Este es el resumen de tu estimación:</p>'
    + '<ul>'
    + '<li><strong>Ciudad:</strong> ' + datos.ciudad + '</li>'
    + '<li><strong>Tipo de uso:</strong> ' + datos.uso + '</li>'
    + '<li><strong>Factura mensual informada:</strong> $' + Number(datos.factura).toLocaleString('es-CO') + '</li>'
    + '</ul>'
    + '<h3>Sistema estimado</h3>'
    + '<p>Tamaño del sistema: <strong>' + resultado.kwp + ' kWp</strong></p>'
    + '<p>Inversión aproximada: <strong>entre $' + resultado.inversion_min.toLocaleString('es-CO') + ' y $' + resultado.inversion_max.toLocaleString('es-CO') + '</strong></p>'
    + '<p>Ahorro mensual estimado: <strong>$' + resultado.ahorro_mes.toLocaleString('es-CO') + '</strong></p>'
    + '<p>Retorno estimado: <strong>~' + resultado.retorno_anios + ' años</strong></p>'
    + '<p style="font-size:.85em;color:#666">Esta es una estimación preliminar; la cotización formal requiere visita técnica.</p>'
    + '<hr style="border:none;border-top:1px solid #ddd;margin:20px 0">'
    + '<p><strong>Victor Manuel Mina</strong> · Dinastel<br>'
    + 'WhatsApp +57 314 556 9567<br>'
    + 'manuelmyna97@gmail.com<br>'
    + 'www.manuelmina.com</p>'
    + '</div>';

  MailApp.sendEmail({
    to: destinatario,
    bcc: 'manuelmyna97@gmail.com',
    subject: asunto,
    htmlBody: cuerpo
  });
}
