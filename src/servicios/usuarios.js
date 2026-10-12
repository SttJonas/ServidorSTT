// Mantiene cuentas e invitaciones en un archivo privado y persistente.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DURACION_INVITACION_MS = 24 * 60 * 60 * 1000;
const ROLES = new Set(["administrador", "operador"]);
const MAXIMO_FOTO_PERFIL = 512 * 1024;

function validarFotoPerfil(fotoPerfil) {
  if (fotoPerfil === null) return null;
  if (
    typeof fotoPerfil !== "string"
    || fotoPerfil.length > Math.ceil(MAXIMO_FOTO_PERFIL * 4 / 3) + 64
  ) {
    throw errorDeSolicitud("La foto debe ser PNG, JPEG o WebP de hasta 512 KiB.");
  }
  const coincidencia = fotoPerfil.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!coincidencia) throw errorDeSolicitud("La foto debe ser PNG, JPEG o WebP de hasta 512 KiB.");
  const contenido = Buffer.from(coincidencia[2], "base64");
  if (
    contenido.length > MAXIMO_FOTO_PERFIL
    || contenido.toString("base64") !== coincidencia[2]
  ) {
    throw errorDeSolicitud("La foto debe ser PNG, JPEG o WebP de hasta 512 KiB.");
  }
  const png = contenido.length >= 8
    && contenido.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = contenido.length >= 3
    && contenido[0] === 0xff
    && contenido[1] === 0xd8
    && contenido[2] === 0xff;
  const webp = contenido.length >= 12
    && contenido.toString("ascii", 0, 4) === "RIFF"
    && contenido.toString("ascii", 8, 12) === "WEBP";
  const formatoValido = coincidencia[1] === "png" ? png
    : coincidencia[1] === "jpeg" ? jpeg
      : webp;
  if (!formatoValido) throw errorDeSolicitud("El contenido no coincide con el formato de imagen indicado.");
  return fotoPerfil;
}

function errorDeSolicitud(mensaje) {
  const error = new Error(mensaje);
  error.estadoHttp = 400;
  return error;
}

function resumenUsuario(usuario) {
  return {
    id: usuario.id,
    usuario: usuario.usuario,
    nombre: usuario.nombre,
    rol: usuario.rol,
    creadoEn: usuario.creadoEn,
  };
}

function validarBaseDatos(datos) {
  if (
    !datos
    || typeof datos !== "object"
    || !Array.isArray(datos.usuarios)
    || !Array.isArray(datos.invitaciones)
  ) {
    throw new Error("El archivo de cuentas no tiene un formato válido.");
  }
  for (const usuario of datos.usuarios) {
    if (
      !usuario
      || typeof usuario.id !== "string"
      || typeof usuario.usuario !== "string"
      || typeof usuario.nombre !== "string"
      || !ROLES.has(usuario.rol)
      || typeof usuario.hashContrasena !== "string"
      || (usuario.fotoPerfil !== undefined && usuario.fotoPerfil !== null && typeof usuario.fotoPerfil !== "string")
    ) {
      throw new Error("El archivo de cuentas contiene un usuario inválido.");
    }
    if (usuario.fotoPerfil !== undefined) {
      try {
        validarFotoPerfil(usuario.fotoPerfil);
      } catch {
        throw new Error("El archivo de cuentas contiene una foto de perfil inválida.");
      }
    }
  }
  for (const invitacion of datos.invitaciones) {
    if (
      !invitacion
      || typeof invitacion.hashToken !== "string"
      || typeof invitacion.usuario !== "string"
      || !ROLES.has(invitacion.rol)
      || !Number.isFinite(invitacion.venceEn)
    ) {
      throw new Error("El archivo de cuentas contiene una invitación inválida.");
    }
  }
  return datos;
}

export function crearServicioUsuarios({
  archivo,
  usuarioAdministrador,
  hashContrasenaAdministrador,
  crearHashContrasena,
  ahora = Date.now,
}) {
  let datos;
  let colaMutaciones = Promise.resolve();

  async function guardar() {
    if (!archivo) return;
    const directorio = path.dirname(archivo);
    await mkdir(directorio, { recursive: true, mode: 0o700 });
    const temporal = `${archivo}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporal, `${JSON.stringify(datos, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporal, archivo);
  }

  async function ejecutarMutacion(mutacion) {
    const operacion = colaMutaciones.then(async () => {
      const anterior = datos;
      datos = structuredClone(datos);
      try {
        return await mutacion();
      } catch (error) {
        datos = anterior;
        throw error;
      }
    });
    colaMutaciones = operacion.catch(() => {});
    return operacion;
  }

  async function inicializar() {
    if (datos) return;
    if (!archivo) {
      datos = { usuarios: [], invitaciones: [] };
    } else {
      try {
        datos = validarBaseDatos(JSON.parse(await readFile(archivo, "utf8")));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        datos = { usuarios: [], invitaciones: [] };
      }
    }

    const administrador = datos.usuarios.find(
      (usuario) => usuario.usuario.toLowerCase() === usuarioAdministrador.toLowerCase(),
    );
    if (!administrador) {
      datos.usuarios.push({
        id: randomBytes(16).toString("hex"),
        usuario: usuarioAdministrador,
        nombre: usuarioAdministrador,
        rol: "administrador",
        hashContrasena: hashContrasenaAdministrador,
        creadoEn: ahora(),
      });
      await guardar();
    }
  }

  async function obtenerPorNombre(usuario) {
    await inicializar();
    const encontrado = datos.usuarios.find(
      (elemento) => elemento.usuario.toLowerCase() === usuario.toLowerCase(),
    );
    return encontrado ? { ...encontrado } : null;
  }

  async function crearInvitacion({ usuario, rol = "operador" }) {
    await inicializar();
    return ejecutarMutacion(async () => {
      datos.invitaciones = datos.invitaciones.filter((invitacion) => invitacion.venceEn > ahora());
      if (typeof usuario !== "string") {
        throw errorDeSolicitud("El nombre de usuario no es válido.");
      }
      const nombre = usuario.trim();
      if (!/^[a-zA-Z0-9_.-]{1,32}$/.test(nombre)) {
        throw errorDeSolicitud("El usuario debe tener entre 1 y 32 caracteres válidos.");
      }
      if (!ROLES.has(rol)) {
        throw errorDeSolicitud("Selecciona un rol válido para la invitación.");
      }
      if (datos.usuarios.some((cuenta) => cuenta.usuario.toLowerCase() === nombre.toLowerCase())) {
        throw errorDeSolicitud("Ya existe una cuenta con ese nombre.");
      }
      if (datos.invitaciones.some((invitacion) => invitacion.usuario.toLowerCase() === nombre.toLowerCase())) {
        throw errorDeSolicitud("Ya existe una invitación pendiente para ese nombre.");
      }
      const token = randomBytes(32).toString("base64url");
      const invitacion = {
        hashToken: createHash("sha256").update(token).digest("hex"),
        usuario: nombre,
        rol,
        venceEn: ahora() + DURACION_INVITACION_MS,
      };
      datos.invitaciones.push(invitacion);
      await guardar();
      return { token, usuario: nombre, rol, venceEn: invitacion.venceEn };
    });
  }

  async function aceptarInvitacion({ token, nombre, contrasena }) {
    await inicializar();
    return ejecutarMutacion(async () => {
      const hashToken = createHash("sha256").update(token).digest("hex");
      const indice = datos.invitaciones.findIndex((invitacion) => invitacion.hashToken === hashToken);
      const invitacion = datos.invitaciones[indice];
      if (!invitacion || invitacion.venceEn <= ahora()) {
        if (invitacion) {
          datos.invitaciones.splice(indice, 1);
          await guardar();
        }
        throw errorDeSolicitud("La invitación no es válida o ya venció.");
      }
      if (typeof nombre !== "string" || nombre.trim().length < 2 || nombre.trim().length > 60) {
        throw errorDeSolicitud("El nombre visible debe tener entre 2 y 60 caracteres.");
      }
      if (typeof contrasena !== "string" || contrasena.length < 14 || contrasena.length > 256) {
        throw errorDeSolicitud("La contraseña debe tener entre 14 y 256 caracteres.");
      }
      const cuenta = {
        id: randomBytes(16).toString("hex"),
        usuario: invitacion.usuario,
        nombre: nombre.trim(),
        rol: invitacion.rol,
        hashContrasena: await crearHashContrasena(contrasena),
        creadoEn: ahora(),
      };
      datos.usuarios.push(cuenta);
      datos.invitaciones.splice(indice, 1);
      await guardar();
      return resumenUsuario(cuenta);
    });
  }

  async function consultarInvitacion(token) {
    await inicializar();
    if (typeof token !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return null;
    const hashToken = createHash("sha256").update(token).digest("hex");
    const invitacion = datos.invitaciones.find((elemento) => elemento.hashToken === hashToken);
    if (!invitacion || invitacion.venceEn <= ahora()) return null;
    return { usuario: invitacion.usuario, rol: invitacion.rol, venceEn: invitacion.venceEn };
  }

  async function listarInvitaciones() {
    await inicializar();
    return datos.invitaciones
      .filter((invitacion) => invitacion.venceEn > ahora())
      .map(({ usuario, rol, venceEn }) => ({ usuario, rol, venceEn }));
  }

  async function revocarInvitacion(usuario) {
    await inicializar();
    return ejecutarMutacion(async () => {
      const anterior = datos.invitaciones.length;
      datos.invitaciones = datos.invitaciones.filter(
        (invitacion) => invitacion.usuario.toLowerCase() !== String(usuario).toLowerCase(),
      );
      if (datos.invitaciones.length === anterior) {
        throw errorDeSolicitud("No hay una invitación pendiente para ese usuario.");
      }
      await guardar();
    });
  }

  async function actualizarPerfil({
    id,
    nombre,
    contrasenaActual,
    nuevaContrasena,
    fotoPerfil,
    verificarContrasena,
  }) {
    await inicializar();
    return ejecutarMutacion(async () => {
      const cuenta = datos.usuarios.find((usuario) => usuario.id === id);
      if (!cuenta) throw errorDeSolicitud("La cuenta ya no existe.");
      if (typeof nombre !== "string" || nombre.trim().length < 2 || nombre.trim().length > 60) {
        throw errorDeSolicitud("El nombre visible debe tener entre 2 y 60 caracteres.");
      }
      const cambioContrasena = nuevaContrasena !== undefined && nuevaContrasena !== "";
      if (cambioContrasena) {
        if (typeof contrasenaActual !== "string" || !(await verificarContrasena(contrasenaActual, cuenta.hashContrasena))) {
          throw errorDeSolicitud("La contraseña actual no coincide.");
        }
        if (typeof nuevaContrasena !== "string" || nuevaContrasena.length < 14 || nuevaContrasena.length > 256) {
          throw errorDeSolicitud("La nueva contraseña debe tener entre 14 y 256 caracteres.");
        }
        cuenta.hashContrasena = await crearHashContrasena(nuevaContrasena);
      }
      cuenta.nombre = nombre.trim();
      if (fotoPerfil !== undefined) cuenta.fotoPerfil = validarFotoPerfil(fotoPerfil);
      await guardar();
      return {
        ...resumenUsuario(cuenta),
        fotoPerfil: cuenta.fotoPerfil ?? null,
        cambioContrasena,
      };
    });
  }

  async function listarUsuarios() {
    await inicializar();
    return datos.usuarios.map(resumenUsuario);
  }

  async function eliminarUsuario(id, usuarioActual) {
    await inicializar();
    return ejecutarMutacion(async () => {
      const indice = datos.usuarios.findIndex((usuario) => usuario.id === id);
      if (indice < 0) throw errorDeSolicitud("La cuenta solicitada no existe.");
      const cuenta = datos.usuarios[indice];
      if (cuenta.usuario === usuarioActual) throw errorDeSolicitud("No puedes eliminar tu propia cuenta.");
      if (
        cuenta.rol === "administrador"
        && datos.usuarios.filter((usuario) => usuario.rol === "administrador").length <= 1
      ) {
        throw errorDeSolicitud("No se puede eliminar al último administrador.");
      }
      datos.usuarios.splice(indice, 1);
      datos.invitaciones = datos.invitaciones.filter(
        (invitacion) => invitacion.usuario.toLowerCase() !== cuenta.usuario.toLowerCase(),
      );
      await guardar();
      return resumenUsuario(cuenta);
    });
  }

  return Object.freeze({
    inicializar,
    obtenerPorNombre,
    crearInvitacion,
    aceptarInvitacion,
    consultarInvitacion,
    listarInvitaciones,
    revocarInvitacion,
    actualizarPerfil,
    listarUsuarios,
    eliminarUsuario,
  });
}
