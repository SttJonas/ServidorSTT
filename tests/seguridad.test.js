// Comprueba los encabezados de seguridad y los controles de origen del panel.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { protegerRespuestaWeb } from "../src/servicios/seguridad-http.js";

async function iniciarServidor(cookieSegura) {
  const aplicacion = express();
  aplicacion.use(protegerRespuestaWeb({ cookieSegura }));
  aplicacion.get("/", (_solicitud, respuesta) => respuesta.send("ok"));
  const servidor = await new Promise((resolver) => {
    const instancia = aplicacion.listen(0, "127.0.0.1", () => resolver(instancia));
  });
  return {
    servidor,
    direccion: `http://127.0.0.1:${servidor.address().port}`,
  };
}

function cerrarServidor(servidor) {
  return new Promise((resolver, rechazar) => {
    servidor.close((error) => (error ? rechazar(error) : resolver()));
  });
}

test("envía CSP y encabezados anti-incrustación en cada respuesta", async () => {
  const { servidor, direccion } = await iniciarServidor(false);
  try {
    const respuesta = await fetch(direccion);
    const politica = respuesta.headers.get("content-security-policy");
    assert.equal(politica.includes("script-src 'self'"), true);
    assert.equal(politica.includes("style-src 'self'"), true);
    assert.equal(politica.includes("style-src-elem 'self' 'unsafe-inline'"), true);
    assert.equal(politica.includes("style-src-attr 'unsafe-inline'"), true);
    assert.equal(politica.includes("frame-ancestors 'none'"), true);
    assert.equal(respuesta.headers.get("x-content-type-options"), "nosniff");
    assert.equal(respuesta.headers.get("x-frame-options"), "DENY");
    assert.equal(respuesta.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
    assert.equal(respuesta.headers.get("strict-transport-security"), null);
  } finally {
    await cerrarServidor(servidor);
  }
});

test("envía HSTS solo cuando el panel se configura para HTTPS", async () => {
  const { servidor, direccion } = await iniciarServidor(true);
  try {
    const respuesta = await fetch(direccion);
    assert.equal(
      respuesta.headers.get("strict-transport-security"),
      "max-age=31536000; includeSubDomains",
    );
  } finally {
    await cerrarServidor(servidor);
  }
});
