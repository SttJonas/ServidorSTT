// Verifica invitaciones, permisos y persistencia de las cuentas del panel.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crearHashContrasena, crearAutenticacion } from "../src/servicios/autenticacion.js";

async function crearServidor(archivoUsuarios, hashAdministrador) {
  const aplicacion = express();
  aplicacion.locals.cookieSeguro = false;
  aplicacion.use(express.json());
  const autenticacion = crearAutenticacion({
    usuarioAdministrador: "administrador",
    hashContrasena: hashAdministrador,
    cookieSegura: false,
    archivoUsuarios,
  });
  await autenticacion.inicializar();
  autenticacion.configurarRutas(
    aplicacion,
    (respuesta) => respuesta.send("acceso"),
    (respuesta) => respuesta.send("registro"),
  );
  aplicacion.use(autenticacion.proteger);
  aplicacion.get("/api/privado", (solicitud, respuesta) => {
    respuesta.json({ usuario: solicitud.usuario, rol: solicitud.cuenta.rol });
  });
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

async function iniciarSesion(direccion, usuario, contrasena) {
  const respuesta = await fetch(`${direccion}/api/autenticacion/iniciar-sesion`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: direccion },
    body: JSON.stringify({ usuario, contrasena }),
  });
  return {
    respuesta,
    cookie: respuesta.headers.get("set-cookie")?.split(";")[0],
  };
}

test("invita operadores, limita su rol y conserva las cuentas tras reiniciar", async () => {
  const directorio = await mkdtemp(path.join(os.tmpdir(), "swatt-usuarios-"));
  const archivoUsuarios = path.join(directorio, "usuarios.json");
  const hashAdministrador = await crearHashContrasena("contrasena-admin-de-prueba-larga");
  let servidor;
  try {
    ({ servidor } = await crearServidor(archivoUsuarios, hashAdministrador));
    const direccion = `http://127.0.0.1:${servidor.address().port}`;
    const admin = await iniciarSesion(direccion, "administrador", "contrasena-admin-de-prueba-larga");
    assert.equal(admin.respuesta.status, 200);

    const crearInvitacion = await fetch(`${direccion}/api/autenticacion/invitaciones`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: direccion,
        Cookie: admin.cookie,
      },
      body: JSON.stringify({ usuario: "operador-uno" }),
    });

    test("permite al administrador seleccionar el rol de la invitación y rechaza otros roles", async () => {
      const directorio = await mkdtemp(path.join(os.tmpdir(), "swatt-roles-invitacion-"));
      const archivoUsuarios = path.join(directorio, "usuarios.json");
      const hashAdministrador = await crearHashContrasena("contrasena-admin-de-prueba-larga");
      let servidor;
      try {
        ({ servidor } = await crearServidor(archivoUsuarios, hashAdministrador));
        const direccion = `http://127.0.0.1:${servidor.address().port}`;
        const admin = await iniciarSesion(direccion, "administrador", "contrasena-admin-de-prueba-larga");

        const invitacionAdministrador = await fetch(`${direccion}/api/autenticacion/invitaciones`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: direccion,
            Cookie: admin.cookie,
          },
          body: JSON.stringify({ usuario: "admin-invitado", rol: "administrador" }),
        });
        assert.equal(invitacionAdministrador.status, 201);
        const datosInvitacion = await invitacionAdministrador.json();
        assert.equal(datosInvitacion.rol, "administrador");

        const aceptar = await fetch(`${direccion}/api/autenticacion/aceptar-invitacion`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: direccion },
          body: JSON.stringify({
            token: datosInvitacion.token,
            nombre: "Admin Invitado",
            contrasena: "contrasena-admin-invitado-segura",
          }),
        });
        assert.equal(aceptar.status, 201);
        assert.equal((await aceptar.json()).rol, "administrador");
        const cookieAdministradorInvitado = aceptar.headers.get("set-cookie").split(";")[0];
        const accesoAdministrativo = await fetch(`${direccion}/api/autenticacion/usuarios`, {
          headers: { Cookie: cookieAdministradorInvitado },
        });
        assert.equal(accesoAdministrativo.status, 200);

        const rolInvalido = await fetch(`${direccion}/api/autenticacion/invitaciones`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: direccion,
            Cookie: admin.cookie,
          },
          body: JSON.stringify({ usuario: "rol-desconocido", rol: "superadmin" }),
        });
        assert.equal(rolInvalido.status, 400);
      } finally {
        if (servidor?.listening) await cerrarServidor(servidor);
        await rm(directorio, { recursive: true, force: true });
      }
    });
    assert.equal(crearInvitacion.status, 201);
    const invitacion = await crearInvitacion.json();
    assert.match(invitacion.enlace, /aceptar-invitacion\?token=/);

    const aceptar = await fetch(`${direccion}/api/autenticacion/aceptar-invitacion`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: direccion },
      body: JSON.stringify({
        token: invitacion.token,
        nombre: "Operador Uno",
        contrasena: "contrasena-operador-de-prueba",
      }),
    });
    assert.equal(aceptar.status, 201);
    const cookieOperador = aceptar.headers.get("set-cookie").split(";")[0];
    assert.equal((await aceptar.json()).rol, "operador");

    const operadores = await fetch(`${direccion}/api/autenticacion/usuarios`, {
      headers: { Cookie: cookieOperador },
    });
    assert.equal(operadores.status, 403);
    const operadorNoInvita = await fetch(`${direccion}/api/autenticacion/invitaciones`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: direccion,
        Cookie: cookieOperador,
      },
      body: JSON.stringify({ usuario: "cuenta-no-autorizada" }),
    });
    assert.equal(operadorNoInvita.status, 403);

    const editarPerfil = await fetch(`${direccion}/api/autenticacion/perfil`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Origin: direccion,
        Cookie: cookieOperador,
      },
      body: JSON.stringify({ nombre: "Operador Editado" }),
    });
    assert.equal(editarPerfil.status, 200);
    assert.equal((await editarPerfil.json()).nombre, "Operador Editado");

    const fotoPerfil = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S0cAAAAASUVORK5CYII=";
    const actualizarFoto = await fetch(`${direccion}/api/autenticacion/perfil`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Origin: direccion,
        Cookie: cookieOperador,
      },
      body: JSON.stringify({ nombre: "Operador Editado", fotoPerfil }),
    });
    assert.equal(actualizarFoto.status, 200);
    assert.equal((await actualizarFoto.json()).fotoPerfil, fotoPerfil);
    const consultarSesion = await fetch(`${direccion}/api/autenticacion/sesion`, {
      headers: { Cookie: cookieOperador },
    });
    assert.equal((await consultarSesion.json()).fotoPerfil, fotoPerfil);

    const fotoNoPermitida = await fetch(`${direccion}/api/autenticacion/perfil`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Origin: direccion,
        Cookie: cookieOperador,
      },
      body: JSON.stringify({ nombre: "Operador Editado", fotoPerfil: "data:image/svg+xml;base64,PHN2Zz4=" }),
    });
    assert.equal(fotoNoPermitida.status, 400);

    const quitarFoto = await fetch(`${direccion}/api/autenticacion/perfil`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Origin: direccion,
        Cookie: cookieOperador,
      },
      body: JSON.stringify({ nombre: "Operador Editado", fotoPerfil: null }),
    });
    assert.equal(quitarFoto.status, 200);
    assert.equal((await quitarFoto.json()).fotoPerfil, null);

    const cuentaPrivada = await fetch(`${direccion}/api/privado`, {
      headers: { Cookie: cookieOperador },
    });
    assert.deepEqual(await cuentaPrivada.json(), { usuario: "operador-uno", rol: "operador" });

    const credencialActualizada = await fetch(`${direccion}/api/autenticacion/perfil`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Origin: direccion,
        Cookie: cookieOperador,
      },
      body: JSON.stringify({
        nombre: "Operador Editado",
        contrasenaActual: "contrasena-operador-de-prueba",
        nuevaContrasena: "nueva-contrasena-operador-muy-segura",
      }),
    });
    assert.equal(credencialActualizada.status, 200);
    const nuevaCookieOperador = credencialActualizada.headers.get("set-cookie").split(";")[0];
    const sesionAnterior = await fetch(`${direccion}/api/privado`, {
      headers: { Cookie: cookieOperador },
    });
    assert.equal(sesionAnterior.status, 401);

    const listadoAdmin = await fetch(`${direccion}/api/autenticacion/usuarios`, {
      headers: { Cookie: admin.cookie },
    });
    assert.equal(listadoAdmin.status, 200);
    const listado = await listadoAdmin.json();
    assert.equal(listado.usuarios.length, 2);
    assert.equal(Object.hasOwn(listado.usuarios[1], "hashContrasena"), false);
    assert.equal(listado.invitaciones.length, 0);

    const invitacionReutilizada = await fetch(
      `${direccion}/api/autenticacion/invitaciones/${encodeURIComponent(invitacion.token)}`,
    );
    assert.equal(invitacionReutilizada.status, 404);

    const invitacionRevocable = await fetch(`${direccion}/api/autenticacion/invitaciones`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: direccion,
        Cookie: admin.cookie,
      },
      body: JSON.stringify({ usuario: "operador-revocable" }),
    });
    const datosInvitacionRevocable = await invitacionRevocable.json();
    const revocarInvitacion = await fetch(
      `${direccion}/api/autenticacion/invitaciones/operador-revocable`,
      {
        method: "DELETE",
        headers: { Origin: direccion, Cookie: admin.cookie },
      },
    );
    assert.equal(revocarInvitacion.status, 200);
    const invitacionRevocada = await fetch(
      `${direccion}/api/autenticacion/invitaciones/${encodeURIComponent(datosInvitacionRevocable.token)}`,
    );
    assert.equal(invitacionRevocada.status, 404);
    await cerrarServidor(servidor);

    ({ servidor } = await crearServidor(archivoUsuarios, hashAdministrador));
    const direccionReiniciada = `http://127.0.0.1:${servidor.address().port}`;
    const accesoPersistente = await iniciarSesion(
      direccionReiniciada,
      "operador-uno",
      "nueva-contrasena-operador-muy-segura",
    );
    assert.equal(accesoPersistente.respuesta.status, 200);
    assert.equal((await accesoPersistente.respuesta.json()).nombre, "Operador Editado");
    assert.ok(nuevaCookieOperador);

    const sesionAdmin = await iniciarSesion(
      direccionReiniciada,
      "administrador",
      "contrasena-admin-de-prueba-larga",
    );
    const listaPersistente = await fetch(`${direccionReiniciada}/api/autenticacion/usuarios`, {
      headers: { Cookie: sesionAdmin.cookie },
    });
    const cuentas = await listaPersistente.json();
    const operador = cuentas.usuarios.find((cuenta) => cuenta.usuario === "operador-uno");
    const revocarCuenta = await fetch(
      `${direccionReiniciada}/api/autenticacion/usuarios/${encodeURIComponent(operador.id)}`,
      {
        method: "DELETE",
        headers: { Origin: direccionReiniciada, Cookie: sesionAdmin.cookie },
      },
    );
    assert.equal(revocarCuenta.status, 200);
    const sesionRevocada = await fetch(`${direccionReiniciada}/api/privado`, {
      headers: { Cookie: accesoPersistente.cookie },
    });
    assert.equal(sesionRevocada.status, 401);
  } finally {
    if (servidor?.listening) await cerrarServidor(servidor);
    await rm(directorio, { recursive: true, force: true });
  }
});
