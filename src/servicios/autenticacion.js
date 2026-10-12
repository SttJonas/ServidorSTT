// Crea credenciales de sesión aleatorias y verifica las contraseñas con scrypt.
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { crearServicioUsuarios } from "./usuarios.js";

const scrypt = promisify(scryptCallback);
const DURACION_SESION_MS = 8 * 60 * 60 * 1000;
const VENTANA_INTENTOS_MS = 15 * 60 * 1000;
const MAX_INTENTOS_FALLIDOS = 5;
const COOKIE_SESION = "swatt_sesion";

// PHP mantiene las cuentas y SQLite; Node conserva sus rutas públicas existentes.
export function crearServicioCuentasPhp({ url, secreto, archivoUsuarios, tiempoEsperaMs = 5000 }) {
  async function solicitar(accion, datos = {}) {
    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), tiempoEsperaMs);
    try {
      const cuerpo = JSON.stringify({ accion, ...datos });
      if (Buffer.byteLength(cuerpo, "utf8") > 20 * 1024 * 1024) {
        throw new Error("La solicitud al servicio PHP supera el límite de 20 MiB.");
      }
      const respuesta = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Cuentas-Api-Secreto": secreto,
        },
        body: cuerpo,
        signal: controlador.signal,
      });
      const resultado = await respuesta.json();
      if (!respuesta.ok) {
        const error = new Error(resultado.mensaje ?? "No se pudo actualizar el registro de cuentas.");
        error.estadoHttp = respuesta.status;
        error.codigo = resultado.error;
        throw error;
      }
      return resultado;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("El servicio PHP de cuentas tardó demasiado en responder.");
      }
      throw error;
    } finally {
      clearTimeout(temporizador);
    }
  }

  return Object.freeze({
    async inicializar() {
      const estado = await solicitar("estado_migracion");
      if (estado.completa) return;
      let cuentasLegadas = null;
      if (archivoUsuarios) {
        try {
          const contenido = await readFile(archivoUsuarios, "utf8");
          if (Buffer.byteLength(contenido, "utf8") > 16 * 1024 * 1024) {
            throw new Error("El archivo anterior de cuentas supera el límite de migración de 16 MiB.");
          }
          cuentasLegadas = JSON.parse(contenido);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      await solicitar("inicializar", { cuentasLegadas });
    },

    async autenticarContrasena({ usuario, contrasena }) {
      return solicitar("iniciar_sesion", { usuario, contrasena });
    },

    async migrarHashLegado({ id, contrasena }) {
      return solicitar("migrar_hash_legado", { id, contrasena });
    },

    async crearSesion(id) {
      return solicitar("crear_sesion", { id });
    },

    async obtenerSesion(token, incluirFoto = false) {
      const resultado = await solicitar("obtener_sesion", { token, incluirFoto });
      return resultado.sesion;
    },

    async cerrarSesion(token) {
      await solicitar("cerrar_sesion", { token });
    },

    async crearInvitacion({ usuario, rol }) {
      return solicitar("crear_invitacion", { usuario, rol });
    },

    async aceptarInvitacion({ token, nombre, contrasena }) {
      const resultado = await solicitar("aceptar_invitacion", { token, nombre, contrasena });
      return resultado.cuenta;
    },

    async consultarInvitacion(token) {
      const resultado = await solicitar("consultar_invitacion", { token });
      return resultado.invitacion;
    },

    async listarInvitaciones() {
      const resultado = await solicitar("listar_invitaciones");
      return resultado.invitaciones;
    },

    async revocarInvitacion(usuario) {
      await solicitar("revocar_invitacion", { usuario });
    },

    async actualizarPerfil(datos) {
      return solicitar("actualizar_perfil", datos);
    },

    async listarUsuarios() {
      const resultado = await solicitar("listar_usuarios");
      return resultado.usuarios;
    },

    async eliminarUsuario(id, usuarioActual) {
      return solicitar("eliminar_usuario", { id, usuarioActual });
    },
  });
}

// Genera el formato de hash usado por el asistente de configuración y el login.
export async function crearHashContrasena(contrasena) {
  const sal = randomBytes(16);
  const hash = await scrypt(contrasena, sal, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt:32768:8:1:${sal.toString("hex")}:${hash.toString("hex")}`;
}

// Compara la contraseña con el hash, incluso si el usuario ingresado no existe.
export async function verificarContrasena(contrasena, hashGuardado) {
  const partes = hashGuardado.split(":");
  if (partes.length !== 6 || partes[0] !== "scrypt") {
    throw new Error("El hash de la contraseña tiene un formato inválido.");
  }

  const [, costo, bloque, paralelismo, salHexadecimal, hashHexadecimal] = partes;
  const sal = Buffer.from(salHexadecimal, "hex");
  const hashEsperado = Buffer.from(hashHexadecimal, "hex");
  const hashCalculado = await scrypt(contrasena, sal, hashEsperado.length, {
    N: Number(costo),
    r: Number(bloque),
    p: Number(paralelismo),
    maxmem: 64 * 1024 * 1024,
  });

  return timingSafeEqual(hashCalculado, hashEsperado);
}

// Recupera una cookie específica sin confiar en valores controlados por el cliente.
function leerCookie(solicitud, nombre) {
  const cookies = solicitud.headers.cookie?.split(";") ?? [];
  const prefijo = `${nombre}=`;
  const cookie = cookies.map((parte) => parte.trim()).find((parte) => parte.startsWith(prefijo));
  return cookie ? cookie.slice(prefijo.length) : null;
}

// Restringe cambios de estado a solicitudes emitidas desde el mismo origen.
function mismoOrigen(solicitud, respuesta, siguiente) {
  const origen = solicitud.get("origin");
  const protocolo = solicitud.secure || solicitud.app.locals.cookieSeguro ? "https" : "http";
  const esperado = `${protocolo}://${solicitud.get("host")}`;
  if (!origen || origen !== esperado) {
    respuesta.status(403).json({ error: "origen_no_permitido" });
    return;
  }
  siguiente();
}

// Proporciona rutas de inicio y cierre de sesión y un middleware de protección.
export function crearAutenticacion({
  usuarioAdministrador,
  hashContrasena,
  cookieSegura,
  archivoUsuarios = null,
  servicioUsuarios: servicioUsuariosExterno = null,
}) {
  const sesiones = new Map();
  const intentosPorOrigen = new Map();
  const servicioUsuarios = servicioUsuariosExterno ?? crearServicioUsuarios({
    archivo: archivoUsuarios,
    usuarioAdministrador,
    hashContrasenaAdministrador: hashContrasena,
    crearHashContrasena,
  });

  async function crearSesion(respuesta, usuario) {
    let token;
    if (usuario.tokenSesion) {
      token = usuario.tokenSesion;
    } else if (typeof servicioUsuarios.crearSesion === "function") {
      ({ token } = await servicioUsuarios.crearSesion(usuario.id));
    } else {
      if (sesiones.size >= 100) {
        const sesionAntigua = sesiones.keys().next().value;
        if (sesionAntigua) sesiones.delete(sesionAntigua);
      }
      token = randomBytes(32).toString("base64url");
      sesiones.set(token, {
        id: usuario.id,
        usuario: usuario.usuario,
        nombre: usuario.nombre,
        rol: usuario.rol,
        fotoPerfil: usuario.fotoPerfil ?? null,
        expira: Date.now() + DURACION_SESION_MS,
      });
    }
    respuesta.cookie(COOKIE_SESION, token, {
      httpOnly: true,
      secure: cookieSegura,
      sameSite: "strict",
      path: "/",
      maxAge: DURACION_SESION_MS,
    });
    respuesta.set("Cache-Control", "no-store");
    return token;
  }

  async function requerirSesion(solicitud, respuesta, siguiente) {
    try {
      const sesion = await obtenerSesion(solicitud);
      if (!sesion) {
        respuesta.status(401).json({ error: "autenticacion_requerida" });
        return;
      }
      solicitud.usuario = sesion.usuario;
      solicitud.cuenta = sesion;
      siguiente();
    } catch (error) {
      console.error("No se pudo comprobar la sesión:", error.message);
      respuesta.status(503).json({
        error: "sesion_no_disponible",
        mensaje: "No se pudo comprobar la sesión. Inténtalo más tarde.",
      });
    }
  }

  function requerirAdministrador(solicitud, respuesta, siguiente) {
    requerirSesion(solicitud, respuesta, () => {
      if (solicitud.cuenta.rol !== "administrador") {
        respuesta.status(403).json({
          error: "permiso_insuficiente",
          mensaje: "Esta acción está disponible solo para administradores.",
        });
        return;
      }
      siguiente();
    });
  }

  function limitarIntentos(origen, respuesta, ahora) {
    limpiarRegistros(ahora);
    let registro = intentosPorOrigen.get(origen);
    if (!registro || ahora - registro.inicio >= VENTANA_INTENTOS_MS) {
      registro = { inicio: ahora, intentos: 0 };
      if (!intentosPorOrigen.has(origen) && intentosPorOrigen.size >= 1000) {
        respuesta.set("Retry-After", "900");
        respuesta.status(429).json({
          error: "demasiados_origenes",
          mensaje: "El servicio de acceso está ocupado. Intenta más tarde.",
        });
        return null;
      }
      intentosPorOrigen.set(origen, registro);
    }
    if (registro.intentos >= MAX_INTENTOS_FALLIDOS) {
      respuesta.set(
        "Retry-After",
        String(Math.ceil((VENTANA_INTENTOS_MS - (ahora - registro.inicio)) / 1000)),
      );
      respuesta.status(429).json({
        error: "demasiados_intentos",
        mensaje: "Demasiados intentos. Espera 15 minutos.",
      });
      return null;
    }
    registro.intentos += 1;
    return registro;
  }

  // Elimina sesiones e intentos vencidos para mantener acotada la memoria.
  function limpiarRegistros(ahora) {
    for (const [token, sesion] of sesiones) {
      if (sesion.expira <= ahora) sesiones.delete(token);
    }
    for (const [origen, registro] of intentosPorOrigen) {
      if (ahora - registro.inicio >= VENTANA_INTENTOS_MS) intentosPorOrigen.delete(origen);
    }
  }

  // Busca una sesión no vencida y limpia las expiradas al consultarlas.
  async function obtenerSesion(solicitud, incluirFoto = false) {
    const token = leerCookie(solicitud, COOKIE_SESION);
    if (!token) return null;
    if (typeof servicioUsuarios.obtenerSesion === "function") {
      const sesion = await servicioUsuarios.obtenerSesion(token, incluirFoto);
      return sesion ? { token, ...sesion } : null;
    }
    const sesion = sesiones.get(token);
    if (!sesion) return null;
    if (sesion.expira <= Date.now()) {
      sesiones.delete(token);
      return null;
    }
    return { token, ...sesion };
  }

  async function autenticarCuenta(usuario, contrasena) {
    if (typeof servicioUsuarios.autenticarContrasena === "function") {
      const resultado = await servicioUsuarios.autenticarContrasena({ usuario, contrasena });
      if (resultado.correcto) {
        return {
          ...resultado.cuenta,
          tokenSesion: resultado.tokenSesion,
          expira: resultado.venceEn,
        };
      }
      if (
        resultado.hashLegado
        && resultado.cuenta
        && await verificarContrasena(contrasena, resultado.hashLegado)
      ) {
        const actualizacion = await servicioUsuarios.migrarHashLegado({
          id: resultado.cuenta.id,
          contrasena,
        });
        return actualizacion.correcto
          ? {
            ...resultado.cuenta,
            tokenSesion: actualizacion.tokenSesion,
            expira: actualizacion.venceEn,
          }
          : null;
      }
      if (!resultado.cuenta) await verificarContrasena(contrasena, hashContrasena);
      return null;
    }

    const cuenta = await servicioUsuarios.obtenerPorNombre(usuario);
    const contrasenaValida = await verificarContrasena(
      contrasena,
      cuenta?.hashContrasena ?? hashContrasena,
    );
    return cuenta && contrasenaValida ? cuenta : null;
  }

  // Sirve la página de acceso sin exponer el resto de recursos del panel.
  function configurarRutas(aplicacion, enviarPaginaAcceso, enviarPaginaRegistro = enviarPaginaAcceso) {
    aplicacion.get("/iniciar-sesion", (_solicitud, respuesta) => {
      respuesta.set("Cache-Control", "no-store");
      enviarPaginaAcceso(respuesta);
    });

    aplicacion.get("/aceptar-invitacion", (_solicitud, respuesta) => {
      respuesta.set("Cache-Control", "no-store");
      enviarPaginaRegistro(respuesta);
    });

    aplicacion.get("/api/autenticacion/sesion", async (solicitud, respuesta) => {
      respuesta.set("Cache-Control", "no-store");
      try {
        const sesion = await obtenerSesion(solicitud, true);
        respuesta.json({
          autenticado: Boolean(sesion),
          usuario: sesion?.usuario ?? null,
          nombre: sesion?.nombre ?? null,
          rol: sesion?.rol ?? null,
          fotoPerfil: sesion?.fotoPerfil ?? null,
          venceEn: sesion?.expira ?? null,
        });
      } catch (error) {
        console.error("No se pudo consultar la sesión:", error.message);
        respuesta.status(503).json({ error: "sesion_no_disponible" });
      }
    });

    aplicacion.get("/api/autenticacion/invitaciones/:token", async (solicitud, respuesta) => {
      try {
        const invitacion = await servicioUsuarios.consultarInvitacion(solicitud.params.token);
        if (!invitacion) {
          respuesta.status(404).json({
            error: "invitacion_invalida",
            mensaje: "La invitación no es válida o ya venció.",
          });
          return;
        }
        respuesta.set("Cache-Control", "no-store");
        respuesta.json(invitacion);
      } catch (error) {
        console.error("No se pudo consultar la invitación:", error.message);
        respuesta.status(503).json({
          error: "cuentas_no_disponibles",
          mensaje: "No se pudo consultar el registro de cuentas.",
        });
      }
    });

    aplicacion.post(
      "/api/autenticacion/aceptar-invitacion",
      mismoOrigen,
      async (solicitud, respuesta) => {
        try {
          const origen = solicitud.ip ?? "desconocido";
          const registro = limitarIntentos(origen, respuesta, Date.now());
          if (!registro) return;
          const { token, nombre, contrasena } = solicitud.body ?? {};
          if (
            typeof token !== "string"
            || typeof contrasena !== "string"
            || contrasena.length > 256
          ) {
            respuesta.status(400).json({
              error: "datos_invalidos",
              mensaje: "Completa los datos de la invitación.",
            });
            return;
          }
          const cuenta = await servicioUsuarios.aceptarInvitacion({ token, nombre, contrasena });
          intentosPorOrigen.delete(origen);
          await crearSesion(respuesta, cuenta);
          respuesta.status(201).json({
            autenticado: true,
            usuario: cuenta.usuario,
            nombre: cuenta.nombre,
            rol: cuenta.rol,
            fotoPerfil: cuenta.fotoPerfil ?? null,
          });
        } catch (error) {
          const cliente = error.estadoHttp === 400;
          if (!cliente) console.error("No se pudo aceptar la invitación:", error.message);
          respuesta.status(cliente ? 400 : 503).json({
            error: cliente ? "invitacion_rechazada" : "cuentas_no_disponibles",
            mensaje: cliente ? error.message : "No se pudo registrar la cuenta. Inténtalo más tarde.",
          });
        }
      },
    );

    aplicacion.post(
      "/api/autenticacion/iniciar-sesion",
      mismoOrigen,
      async (solicitud, respuesta) => {
        const origen = solicitud.ip ?? "desconocido";
        const ahora = Date.now();
        const registro = limitarIntentos(origen, respuesta, ahora);
        if (!registro) return;

        const usuario = typeof solicitud.body?.usuario === "string" ? solicitud.body.usuario : "";
        const contrasena = typeof solicitud.body?.contrasena === "string" ? solicitud.body.contrasena : "";
        if (usuario.length > 32 || contrasena.length > 256) {
          respuesta.status(401).json({ error: "credenciales_invalidas", mensaje: "Usuario o contraseña incorrectos." });
          return;
        }
        try {
          const cuenta = await autenticarCuenta(usuario, contrasena);
          if (!cuenta) {
            respuesta.status(401).json({ error: "credenciales_invalidas", mensaje: "Usuario o contraseña incorrectos." });
            return;
          }

          intentosPorOrigen.delete(origen);
          await crearSesion(respuesta, cuenta);
          respuesta.json({
            autenticado: true,
            usuario: cuenta.usuario,
            nombre: cuenta.nombre,
            rol: cuenta.rol,
          });
        } catch (error) {
          console.error("No se pudo validar el acceso con el servicio de cuentas:", error.message);
          respuesta.status(503).json({
            error: "cuentas_no_disponibles",
            mensaje: "No se pudo validar el acceso. Inténtalo más tarde.",
          });
        }
      },
    );

    aplicacion.patch(
      "/api/autenticacion/perfil",
      mismoOrigen,
      requerirSesion,
      async (solicitud, respuesta) => {
        try {
          let resultadoPerfil = await servicioUsuarios.actualizarPerfil({
            id: solicitud.cuenta.id,
            nombre: solicitud.body?.nombre,
            contrasenaActual: solicitud.body?.contrasenaActual,
            nuevaContrasena: solicitud.body?.nuevaContrasena,
            fotoPerfil: solicitud.body?.fotoPerfil,
            verificarContrasena,
          });
          if (resultadoPerfil.hashLegado) {
            const actual = solicitud.body?.contrasenaActual;
            if (
              typeof actual !== "string"
              || !(await verificarContrasena(actual, resultadoPerfil.hashLegado))
            ) {
              const error = new Error("La contraseña actual no coincide.");
              error.estadoHttp = 400;
              throw error;
            }
            resultadoPerfil = await servicioUsuarios.actualizarPerfil({
              id: solicitud.cuenta.id,
              nombre: solicitud.body?.nombre,
              contrasenaActual: actual,
              nuevaContrasena: solicitud.body?.nuevaContrasena,
              fotoPerfil: solicitud.body?.fotoPerfil,
              hashLegadoVerificado: true,
              verificarContrasena,
            });
          }
          const actualizada = resultadoPerfil.cuenta ?? resultadoPerfil;
          const cambioContrasena = resultadoPerfil.cambioContrasena;
          for (const sesion of sesiones.values()) {
            if (sesion.id === actualizada.id) {
              sesion.nombre = actualizada.nombre;
              sesion.fotoPerfil = actualizada.fotoPerfil ?? null;
            }
          }
          if (cambioContrasena) {
            for (const [token, sesion] of sesiones) {
              if (sesion.id === actualizada.id) sesiones.delete(token);
            }
            await crearSesion(respuesta, actualizada);
          }
          respuesta.set("Cache-Control", "no-store");
          respuesta.json({
            usuario: actualizada.usuario,
            nombre: actualizada.nombre,
            rol: actualizada.rol,
            fotoPerfil: actualizada.fotoPerfil ?? null,
            venceEn: solicitud.cuenta.expira,
          });
        } catch (error) {
          const cliente = error.estadoHttp === 400;
          if (!cliente) console.error("No se pudo actualizar el perfil:", error.message);
          respuesta.status(cliente ? 400 : 503).json({
            error: cliente ? "perfil_invalido" : "cuentas_no_disponibles",
            mensaje: cliente ? error.message : "No se pudo guardar el perfil.",
          });
        }
      },
    );

    aplicacion.get(
      "/api/autenticacion/usuarios",
      requerirAdministrador,
      async (_solicitud, respuesta) => {
        try {
          const [usuarios, invitaciones] = await Promise.all([
            servicioUsuarios.listarUsuarios(),
            servicioUsuarios.listarInvitaciones(),
          ]);
          respuesta.set("Cache-Control", "no-store");
          respuesta.json({ usuarios, invitaciones });
        } catch (error) {
          console.error("No se pudo listar las cuentas:", error.message);
          respuesta.status(503).json({
            error: "cuentas_no_disponibles",
            mensaje: "No se pudo consultar el registro de cuentas.",
          });
        }
      },
    );

    aplicacion.post(
      "/api/autenticacion/invitaciones",
      mismoOrigen,
      requerirAdministrador,
      async (solicitud, respuesta) => {
        try {
          const invitacion = await servicioUsuarios.crearInvitacion({
            usuario: solicitud.body?.usuario,
            rol: solicitud.body?.rol,
          });
          const origen = solicitud.get("origin");
          respuesta.set("Cache-Control", "no-store");
          respuesta.status(201).json({
            ...invitacion,
            enlace: `${origen}/aceptar-invitacion?token=${encodeURIComponent(invitacion.token)}`,
          });
        } catch (error) {
          const cliente = error.estadoHttp === 400;
          if (!cliente) console.error("No se pudo crear la invitación:", error.message);
          respuesta.status(cliente ? 400 : 503).json({
            error: cliente ? "invitacion_invalida" : "cuentas_no_disponibles",
            mensaje: cliente ? error.message : "No se pudo crear la invitación.",
          });
        }
      },
    );

    aplicacion.delete(
      "/api/autenticacion/invitaciones/:usuario",
      mismoOrigen,
      requerirAdministrador,
      async (solicitud, respuesta) => {
        try {
          await servicioUsuarios.revocarInvitacion(solicitud.params.usuario);
          respuesta.json({ correcto: true });
        } catch (error) {
          const cliente = error.estadoHttp === 400;
          if (!cliente) console.error("No se pudo revocar la invitación:", error.message);
          respuesta.status(cliente ? 400 : 503).json({
            error: cliente ? "invitacion_no_revocada" : "cuentas_no_disponibles",
            mensaje: cliente ? error.message : "No se pudo revocar la invitación.",
          });
        }
      },
    );

    aplicacion.delete(
      "/api/autenticacion/usuarios/:id",
      mismoOrigen,
      requerirAdministrador,
      async (solicitud, respuesta) => {
        try {
          const eliminado = await servicioUsuarios.eliminarUsuario(
            solicitud.params.id,
            solicitud.cuenta.usuario,
          );
          for (const [token, sesion] of sesiones) {
            if (sesion.id === eliminado.id) sesiones.delete(token);
          }
          respuesta.json({ correcto: true, usuario: eliminado.usuario });
        } catch (error) {
          const cliente = error.estadoHttp === 400;
          if (!cliente) console.error("No se pudo eliminar la cuenta:", error.message);
          respuesta.status(cliente ? 400 : 503).json({
            error: cliente ? "cuenta_no_eliminada" : "cuentas_no_disponibles",
            mensaje: cliente ? error.message : "No se pudo eliminar la cuenta.",
          });
        }
      },
    );

    aplicacion.post("/api/autenticacion/cerrar-sesion", mismoOrigen, async (solicitud, respuesta) => {
      try {
        const sesion = await obtenerSesion(solicitud);
        if (sesion) {
          if (typeof servicioUsuarios.cerrarSesion === "function") {
            await servicioUsuarios.cerrarSesion(sesion.token);
          } else {
            sesiones.delete(sesion.token);
          }
        }
        respuesta.clearCookie(COOKIE_SESION, {
          httpOnly: true,
          secure: cookieSegura,
          sameSite: "strict",
          path: "/",
        });
        respuesta.set("Cache-Control", "no-store");
        respuesta.json({ autenticado: false });
      } catch (error) {
        console.error("No se pudo cerrar la sesión:", error.message);
        respuesta.status(503).json({ error: "sesion_no_disponible" });
      }
    });
  }

  // Bloquea las rutas privadas y exige una sesión vigente.
  async function proteger(solicitud, respuesta, siguiente) {
    try {
      const sesion = await obtenerSesion(solicitud);
      if (!sesion) {
        if (solicitud.path.startsWith("/api/")) {
          respuesta.status(401).json({ error: "autenticacion_requerida" });
        } else {
          respuesta.redirect(303, "/iniciar-sesion");
        }
        return;
      }
      solicitud.usuario = sesion.usuario;
      solicitud.cuenta = sesion;
      respuesta.set("Cache-Control", "no-store");
      siguiente();
    } catch (error) {
      console.error("No se pudo autorizar la sesión:", error.message);
      if (solicitud.path.startsWith("/api/")) {
        respuesta.status(503).json({ error: "sesion_no_disponible" });
      } else {
        respuesta.status(503).send("El servicio de autenticación no está disponible. Inténtalo más tarde.");
      }
    }
  }

  // Expone solo la configuración de rutas, protección y utilidades necesarias.
  return {
    configurarRutas,
    proteger,
    mismoOrigen,
    obtenerSesion,
    inicializar: servicioUsuarios.inicializar,
  };
}
