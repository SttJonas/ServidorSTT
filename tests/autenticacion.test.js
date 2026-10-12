// Comprueba el hash de contraseña y el ciclo de vida de la sesión de administrador.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { crearHashContrasena, crearAutenticacion } from "../src/servicios/autenticacion.js";

// Construye una aplicación HTTP efímera para probar las rutas reales de acceso.
async function crearServidorPrueba({ cookieSeguro = false } = {}) {
  const hash = await crearHashContrasena("una-contrasena-segura-de-prueba");
  const aplicacion = express();
  aplicacion.locals.cookieSeguro = cookieSeguro;
  aplicacion.set("trust proxy", "loopback");
  aplicacion.use(express.json());
  const autenticacion = crearAutenticacion({
    usuarioAdministrador: "administrador",
    hashContrasena: hash,
    cookieSegura: cookieSeguro,
  });
  autenticacion.configurarRutas(aplicacion, (respuesta) => respuesta.send("acceso"));
  aplicacion.use(autenticacion.proteger);
  aplicacion.get("/api/privado", (solicitud, respuesta) => respuesta.json({ usuario: solicitud.usuario }));
  const servidor = await new Promise((resolver) => {
    const instancia = aplicacion.listen(0, "127.0.0.1", () => resolver(instancia));
  });
  const direccion = `http://127.0.0.1:${servidor.address().port}`;
  return { servidor, direccion };
}

// Finaliza el servidor de prueba y libera su puerto.
function cerrarServidor(servidor) {
  return new Promise((resolver, rechazar) => {
    servidor.close((error) => (error ? rechazar(error) : resolver()));
  });
}

test("rechaza el acceso privado sin sesión", async () => {
  const { servidor, direccion } = await crearServidorPrueba();
  try {
    const respuesta = await fetch(`${direccion}/api/privado`);
    assert.equal(respuesta.status, 401);
    assert.deepEqual(await respuesta.json(), { error: "autenticacion_requerida" });
  } finally {
    await cerrarServidor(servidor);
  }
});

test("inicia sesión, protege rutas y revoca la sesión al salir", async () => {
  const { servidor, direccion } = await crearServidorPrueba();
  const origen = direccion;
  try {
    const acceso = await fetch(`${direccion}/api/autenticacion/iniciar-sesion`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origen },
      body: JSON.stringify({
        usuario: "administrador",
        contrasena: "una-contrasena-segura-de-prueba",
      }),
    });
    assert.equal(acceso.status, 200);
    const cookie = acceso.headers.get("set-cookie").split(";")[0];
    assert.match(acceso.headers.get("set-cookie"), /HttpOnly/);
    assert.match(acceso.headers.get("set-cookie"), /SameSite=Strict/);

    const privado = await fetch(`${direccion}/api/privado`, {
      headers: { Cookie: cookie },
    });
    assert.equal(privado.status, 200);
    assert.deepEqual(await privado.json(), { usuario: "administrador" });

    const salida = await fetch(`${direccion}/api/autenticacion/cerrar-sesion`, {
      method: "POST",
      headers: { Origin: origen, Cookie: cookie },
    });
    assert.equal(salida.status, 200);

    const revocado = await fetch(`${direccion}/api/privado`, {
      headers: { Cookie: cookie },
    });
    assert.equal(revocado.status, 401);
  } finally {
    await cerrarServidor(servidor);
  }
});

test("valida sesiones persistidas por el servicio PHP y revócalas al cerrar", async () => {
  const hash = await crearHashContrasena("una-contrasena-segura-de-prueba");
  const tokenSesion = "A".repeat(43);
  let sesionPersistida = null;
  const solicitudesSesion = [];
  const servicioUsuarios = {
    async inicializar() {},
    async autenticarContrasena() {
      return {
        correcto: true,
        cuenta: {
          id: "0123456789abcdef0123456789abcdef",
          usuario: "administrador",
          nombre: "Administrador",
          rol: "administrador",
        },
      };
    },
    async crearSesion(id) {
      sesionPersistida = {
        token: tokenSesion,
        id,
        usuario: "administrador",
        nombre: "Administrador",
        rol: "administrador",
        fotoPerfil: null,
        expira: Date.now() + 60_000,
      };
      return { token: tokenSesion };
    },
    async obtenerSesion(token, incluirFoto = false) {
      solicitudesSesion.push(incluirFoto);
      return token === tokenSesion ? sesionPersistida : null;
    },
    async cerrarSesion(token) {
      if (token === tokenSesion) sesionPersistida = null;
    },
  };
  const aplicacion = express();
  aplicacion.locals.cookieSeguro = false;
  aplicacion.use(express.json());
  const autenticacion = crearAutenticacion({
    usuarioAdministrador: "administrador",
    hashContrasena: hash,
    cookieSegura: false,
    servicioUsuarios,
  });
  autenticacion.configurarRutas(aplicacion, (respuesta) => respuesta.send("acceso"));
  aplicacion.use(autenticacion.proteger);
  aplicacion.get("/api/privado", (solicitud, respuesta) => respuesta.json({ usuario: solicitud.usuario }));
  const servidor = await new Promise((resolver) => {
    const instancia = aplicacion.listen(0, "127.0.0.1", () => resolver(instancia));
  });
  const direccion = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const login = await fetch(`${direccion}/api/autenticacion/iniciar-sesion`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: direccion },
      body: JSON.stringify({
        usuario: "administrador",
        contrasena: "una-contrasena-segura-de-prueba",
      }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, new RegExp(tokenSesion));
    const privado = await fetch(`${direccion}/api/privado`, { headers: { Cookie: cookie } });
    assert.equal(privado.status, 200);
    assert.equal(solicitudesSesion.at(-1), false);

    const sesion = await fetch(`${direccion}/api/autenticacion/sesion`, {
      headers: { Cookie: cookie },
    });
    assert.equal(sesion.status, 200);
    assert.equal((await sesion.json()).autenticado, true);
    assert.equal(solicitudesSesion.at(-1), true);

    const cerrar = await fetch(`${direccion}/api/autenticacion/cerrar-sesion`, {
      method: "POST",
      headers: { Origin: direccion, Cookie: cookie },
    });
    assert.equal(cerrar.status, 200);
    assert.equal(sesionPersistida, null);
    assert.equal((await fetch(`${direccion}/api/privado`, { headers: { Cookie: cookie } })).status, 401);
  } finally {
    await cerrarServidor(servidor);
  }
});

test("marca la cookie como Secure cuando se sirve mediante HTTPS", async () => {
  const { servidor, direccion } = await crearServidorPrueba({ cookieSeguro: true });
  const origenSeguro = direccion.replace("http://", "https://");
  try {
    const respuesta = await fetch(`${direccion}/api/autenticacion/iniciar-sesion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origenSeguro,
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({
        usuario: "administrador",
        contrasena: "una-contrasena-segura-de-prueba",
      }),
    });
    assert.equal(respuesta.status, 200);
    assert.match(respuesta.headers.get("set-cookie"), /Secure/);
  } finally {
    await cerrarServidor(servidor);
  }
});

test("rechaza una solicitud de acceso cuyo origen no coincide", async () => {
  const { servidor, direccion } = await crearServidorPrueba();
  try {
    const respuesta = await fetch(`${direccion}/api/autenticacion/iniciar-sesion`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://origen-invalido.example" },
      body: JSON.stringify({ usuario: "administrador", contrasena: "incorrecta" }),
    });
    assert.equal(respuesta.status, 403);
  } finally {
    await cerrarServidor(servidor);
  }
});

test("bloquea el origen tras cinco contraseñas inválidas", async () => {
  const { servidor, direccion } = await crearServidorPrueba();
  try {
    for (let intento = 0; intento < 5; intento += 1) {
      const respuesta = await fetch(`${direccion}/api/autenticacion/iniciar-sesion`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: direccion },
        body: JSON.stringify({ usuario: "administrador", contrasena: "incorrecta" }),
      });
      assert.equal(respuesta.status, 401);
    }
    const bloqueada = await fetch(`${direccion}/api/autenticacion/iniciar-sesion`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: direccion },
      body: JSON.stringify({ usuario: "administrador", contrasena: "incorrecta" }),
    });
    assert.equal(bloqueada.status, 429);
    assert.ok(Number(bloqueada.headers.get("retry-after")) > 0);
  } finally {
    await cerrarServidor(servidor);
  }
});
