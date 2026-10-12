// Envía solicitudes JSON acotadas al agente local mediante un socket Unix.
import net from "node:net";

const RUTA_SOCKET = "/run/swatt-monitor/acciones.sock";
const ACCIONES_PERMITIDAS = new Set(["iniciar", "detener", "reiniciar"]);
const ACCIONES_PHP_PERMITIDAS = new Set(["iniciar", "detener", "reiniciar"]);
const MOTORES_BASES_DATOS = new Set(["postgresql", "mariadb", "mongodb", "redis"]);
const PERFILES_RUNTIME = new Set([
  "html", "php", "node", "react", "python", "ruby", "java", "kotlin", "go", "rust",
]);

function urlPrivadaTailscaleValida(urlPrivada, puerto) {
  if (urlPrivada === undefined || urlPrivada === null) return true;
  if (typeof urlPrivada !== "string") return false;
  try {
    const url = new URL(urlPrivada);
    const octetos = url.hostname.split(".").map(Number);
    return url.protocol === "http:"
      && octetos.length === 4
      && octetos.every((octeto) => Number.isInteger(octeto) && octeto >= 0 && octeto <= 255)
      && octetos[0] === 100
      && octetos[1] >= 64
      && octetos[1] <= 127
      && url.port === String(puerto)
      && url.pathname === "/"
      && !url.search
      && !url.hash
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function rutaInicioValida(rutaInicio) {
  return rutaInicio === undefined
    || rutaInicio === null
    || rutaInicio === ""
    || (
      typeof rutaInicio === "string"
      && rutaInicio.length <= 512
      && !rutaInicio.startsWith("/")
      && !rutaInicio.includes("\\")
      && !rutaInicio.includes("\0")
      && rutaInicio.split("/").every((segmento) => segmento && segmento !== "." && segmento !== "..")
    );
}

// Envía una solicitud local y rechaza respuestas incompletas o excesivamente lentas.
function solicitarAccion(solicitud) {
  return new Promise((resolver, rechazar) => {
    const conexion = net.createConnection(RUTA_SOCKET);
    let respuesta = "";
    let finalizada = false;

    function fallar(error) {
      if (finalizada) return;
      finalizada = true;
      conexion.destroy();
      rechazar(error);
    }

    conexion.setTimeout(300000, () => fallar(new Error("Tiempo de espera agotado para el agente Docker.")));
    conexion.on("connect", () => {
      conexion.write(`${JSON.stringify(solicitud)}\n`);
    });
    conexion.on("data", (fragmento) => {
      respuesta += fragmento.toString("utf8");
      if (respuesta.length > 8192) {
        fallar(new Error("La respuesta del agente excede el límite permitido."));
        return;
      }
      const finLinea = respuesta.indexOf("\n");
      if (finLinea < 0) return;
      try {
        const resultado = JSON.parse(respuesta.slice(0, finLinea));
        finalizada = true;
        conexion.end();
        resolver(resultado);
      } catch {
        fallar(new Error("El agente Docker devolvió una respuesta inválida."));
      }
    });
    conexion.on("error", (error) => fallar(error));
    conexion.on("end", () => {
      if (!finalizada) fallar(new Error("El agente Docker cerró la conexión sin responder."));
    });
  });
}

// Valida formato y valores antes de remitir una petición al agente con permisos.
export function crearServicioDocker({ enviarSolicitud = solicitarAccion } = {}) {
  return Object.freeze({
    async ejecutarAccion({ id, accion, nombreConfirmado }) {
      if (typeof id !== "string" || !/^[a-f0-9]{12,64}$/i.test(id)) {
        return { correcto: false, codigo: "identificador_invalido", mensaje: "Identificador de contenedor inválido." };
      }
      if (!ACCIONES_PERMITIDAS.has(accion)) {
        return { correcto: false, codigo: "accion_no_permitida", mensaje: "La acción solicitada no está permitida." };
      }
      if (typeof nombreConfirmado !== "string" || nombreConfirmado.trim().length < 1 || nombreConfirmado.length > 128) {
        return { correcto: false, codigo: "confirmacion_invalida", mensaje: "Escribe el nombre exacto del contenedor." };
      }
      return enviarSolicitud({ id, accion, nombreConfirmado });
    },

    async desplegarPhp({ id, nombreConfirmado }) {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) {
        return { correcto: false, codigo: "identificador_invalido", mensaje: "Identificador de proyecto inválido." };
      }
      if (typeof nombreConfirmado !== "string" || nombreConfirmado.trim().length < 2 || nombreConfirmado.length > 60) {
        return { correcto: false, codigo: "confirmacion_invalida", mensaje: "Escribe el nombre exacto del proyecto." };
      }
      const resultado = await enviarSolicitud({ accion: "desplegar_php", id, nombreConfirmado });
      if (
        resultado?.correcto !== true
        && (typeof resultado?.mensaje !== "string" || resultado.mensaje.length > 256)
      ) {
        return { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió una respuesta de despliegue inválida." };
      }
      if (resultado.correcto !== true) return resultado;
      if (
        resultado.nombre !== nombreConfirmado
        || !Number.isInteger(resultado.puerto)
        || resultado.puerto < 18080
        || resultado.puerto > 18179
        || !rutaInicioValida(resultado.rutaInicio)
      ) {
        return { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió datos de despliegue inválidos." };
      }
      return resultado;
    },

    async desplegarAplicacion({ id, perfil, nombreConfirmado }) {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) {
        return { correcto: false, codigo: "identificador_invalido", mensaje: "Identificador de proyecto inválido." };
      }
      if (!PERFILES_RUNTIME.has(perfil)) {
        return { correcto: false, codigo: "perfil_no_permitido", mensaje: "El perfil de aplicación no está permitido." };
      }
      if (typeof nombreConfirmado !== "string" || nombreConfirmado.trim().length < 2 || nombreConfirmado.length > 60) {
        return { correcto: false, codigo: "confirmacion_invalida", mensaje: "Escribe el nombre exacto del proyecto." };
      }
      const resultado = perfil === "php"
        ? await enviarSolicitud({ accion: "desplegar_php", id, nombreConfirmado })
        : await enviarSolicitud({ accion: "desplegar_app", id, perfil, nombreConfirmado });
      if (
        resultado?.correcto !== true
        && (typeof resultado?.mensaje !== "string" || resultado.mensaje.length > 256)
      ) {
        return { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió una respuesta de despliegue inválida." };
      }
      if (resultado.correcto !== true) return resultado;
      if (
        resultado.nombre !== nombreConfirmado
        || !Number.isInteger(resultado.puerto)
        || resultado.puerto < 18080
        || resultado.puerto > 18179
      ) {
        return { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió datos de despliegue inválidos." };
      }
      return { ...resultado, perfil };
    },

    async consultarRuntime() {
      const resultado = await enviarSolicitud({ accion: "php_estado" });
      if (
        resultado?.correcto !== true
        || !Array.isArray(resultado.proyectos)
        || resultado.proyectos.length > 25
        || resultado.proyectos.some((proyecto) => (
          !proyecto
          || typeof proyecto.id !== "string"
          || !/^[a-f0-9-]{36}$/i.test(proyecto.id)
          || typeof proyecto.nombre !== "string"
          || !["activo", "detenido", "no_disponible"].includes(proyecto.estado)
          || !Number.isInteger(proyecto.puerto)
          || proyecto.puerto < 18080
          || proyecto.puerto > 18179
          || !urlPrivadaTailscaleValida(proyecto.urlPrivada, proyecto.puerto)
          || !rutaInicioValida(proyecto.rutaInicio)
          || (proyecto.rutaProyecto !== undefined && (
            typeof proyecto.rutaProyecto !== "string"
            || !proyecto.rutaProyecto.startsWith("/")
            || !proyecto.rutaProyecto.endsWith(`/${proyecto.id}`)
            || proyecto.rutaProyecto.length > 512
          ))
          || (proyecto.rutaRuntime !== undefined && (
            typeof proyecto.rutaRuntime !== "string"
            || !proyecto.rutaRuntime.startsWith("/")
            || !proyecto.rutaRuntime.endsWith(`/${proyecto.id}`)
            || proyecto.rutaRuntime.length > 512
          ))
          || (proyecto.rutaDatos !== undefined && proyecto.rutaDatos !== null && (
            typeof proyecto.rutaDatos !== "string"
            || !proyecto.rutaDatos.startsWith("/")
            || proyecto.rutaDatos.length > 512
          ))
        ))
      ) {
        throw new Error("El agente devolvió un estado de runtime inválido.");
      }
      return resultado.proyectos;
    },

    async operarRuntime({ id, accion, nombreConfirmado }) {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) {
        return { correcto: false, codigo: "identificador_invalido", mensaje: "Identificador de proyecto inválido." };
      }
      if (!ACCIONES_PHP_PERMITIDAS.has(accion)) {
        return { correcto: false, codigo: "accion_no_permitida", mensaje: "La acción de proyecto no está permitida." };
      }
      if (typeof nombreConfirmado !== "string" || nombreConfirmado.trim().length < 2 || nombreConfirmado.length > 60) {
        return { correcto: false, codigo: "confirmacion_invalida", mensaje: "Escribe el nombre exacto del proyecto." };
      }
      const resultado = await enviarSolicitud({ accion: `php_${accion}`, id, nombreConfirmado });
      if (
        resultado?.correcto !== true
        && (typeof resultado?.mensaje !== "string" || resultado.mensaje.length > 256)
      ) {
        return { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió una respuesta inválida." };
      }
      if (resultado.correcto !== true) return resultado;
      if (
        resultado.nombre !== nombreConfirmado
        || !Number.isInteger(resultado.puerto)
        || resultado.puerto < 18080
        || resultado.puerto > 18179
        || !["activo", "detenido"].includes(resultado.estado)
      ) {
        return { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió datos de proyecto inválidos." };
      }
      return resultado;
    },

    async prepararActualizacion({ id, nombreConfirmado }) {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) {
        return { correcto: false, codigo: "identificador_invalido", mensaje: "Identificador de proyecto inválido." };
      }
      if (
        typeof nombreConfirmado !== "string"
        || nombreConfirmado.trim().length < 2
        || nombreConfirmado.length > 60
      ) {
        return { correcto: false, codigo: "confirmacion_invalida", mensaje: "Escribe el nombre exacto del proyecto." };
      }
      const resultado = await enviarSolicitud({
        accion: "preparar_actualizacion",
        id,
        nombreConfirmado,
      });
      if (
        resultado?.correcto !== true
        && (typeof resultado?.mensaje !== "string" || resultado.mensaje.length > 256)
      ) {
        return { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió una respuesta inválida." };
      }
      if (resultado.correcto !== true) return resultado;
      if (
        resultado.nombre !== nombreConfirmado
        || !PERFILES_RUNTIME.has(resultado.perfil)
        || (resultado.recrear !== undefined && typeof resultado.recrear !== "boolean")
      ) {
        return { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió datos de actualización inválidos." };
      }
      return resultado;
    },

    async archivarProyecto({ id, nombreConfirmado }) {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) {
        return { correcto: false, codigo: "identificador_invalido", mensaje: "Identificador de proyecto inválido." };
      }
      if (typeof nombreConfirmado !== "string" || nombreConfirmado.trim().length < 2 || nombreConfirmado.length > 60) {
        return { correcto: false, codigo: "confirmacion_invalida", mensaje: "Escribe el nombre exacto del proyecto." };
      }
      const resultado = await enviarSolicitud({ accion: "archivar_proyecto", id, nombreConfirmado });
      if (
        resultado?.correcto !== true
        && (typeof resultado?.mensaje !== "string" || resultado.mensaje.length > 256)
      ) {
        return { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió una respuesta inválida." };
      }
      if (
        resultado.correcto !== true
        || resultado.nombre !== nombreConfirmado
        || typeof resultado.baseDatosConservada !== "boolean"
      ) {
        return resultado.correcto === true
          ? { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió datos de archivo inválidos." }
          : resultado;
      }
      return resultado;
    },

    async crearBaseDatos({ id, motor, nombreConfirmado, nombreBaseDatos }) {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) {
        return { correcto: false, codigo: "identificador_invalido", mensaje: "Identificador de proyecto inválido." };
      }
      if (!MOTORES_BASES_DATOS.has(motor)) {
        return { correcto: false, codigo: "motor_no_permitido", mensaje: "El motor de base de datos no está permitido." };
      }
      if (typeof nombreConfirmado !== "string" || nombreConfirmado.trim().length < 2 || nombreConfirmado.length > 60) {
        return { correcto: false, codigo: "confirmacion_invalida", mensaje: "Escribe el nombre exacto del proyecto." };
      }
      const nombreBase = nombreBaseDatos ?? (motor === "redis" ? "0" : "swatt");
      if (motor === "redis" ? nombreBase !== "0" : typeof nombreBase !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(nombreBase)) {
        return { correcto: false, codigo: "nombre_base_invalido", mensaje: "El nombre de la base debe comenzar con una letra minúscula y contener solo letras, números o guion bajo." };
      }
      const resultado = await enviarSolicitud({
        accion: "crear_base_datos",
        id,
        motor,
        nombreConfirmado,
        nombreBaseDatos: nombreBase,
      });
      if (
        resultado?.correcto !== true
        && (typeof resultado?.mensaje !== "string" || resultado.mensaje.length > 256)
      ) {
        return { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió una respuesta inválida." };
      }
      if (resultado.correcto !== true) return resultado;
      if (
        resultado.motor !== motor
        || resultado.host !== "base-datos"
        || !Number.isInteger(resultado.puerto)
        || typeof resultado.nombre !== "string"
        || typeof resultado.usuario !== "string"
        || typeof resultado.contrasena !== "string"
        || typeof resultado.rutaDatos !== "string"
        || !resultado.rutaDatos.startsWith("/")
        || !/^[a-f0-9]{64}$/.test(resultado.contrasena)
      ) {
        return { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió datos de conexión inválidos." };
      }
      return resultado;
    },

    async consultarCredencialesBaseDatos({ id, motor, nombreConfirmado, nombreBaseDatos }) {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) {
        return { correcto: false, codigo: "identificador_invalido", mensaje: "Identificador de proyecto inválido." };
      }
      if (!MOTORES_BASES_DATOS.has(motor)) {
        return { correcto: false, codigo: "motor_no_permitido", mensaje: "El motor de base de datos no está permitido." };
      }
      if (typeof nombreConfirmado !== "string" || nombreConfirmado.trim().length < 2 || nombreConfirmado.length > 60) {
        return { correcto: false, codigo: "confirmacion_invalida", mensaje: "Escribe el nombre exacto del proyecto." };
      }
      const nombreBase = nombreBaseDatos ?? (motor === "redis" ? "0" : "swatt");
      if (motor === "redis" ? nombreBase !== "0" : typeof nombreBase !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(nombreBase)) {
        return { correcto: false, codigo: "nombre_base_invalido", mensaje: "El nombre de la base no es válido." };
      }
      const resultado = await enviarSolicitud({
        accion: "credenciales_base_datos",
        id,
        motor,
        nombreConfirmado,
        nombreBaseDatos: nombreBase,
      });
      if (
        resultado?.correcto !== true
        && (typeof resultado?.mensaje !== "string" || resultado.mensaje.length > 256)
      ) {
        return { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió una respuesta inválida." };
      }
      if (resultado.correcto !== true) return resultado;
      if (
        resultado.motor !== motor
        || resultado.host !== "base-datos"
        || !Number.isInteger(resultado.puerto)
        || typeof resultado.nombre !== "string"
        || typeof resultado.usuario !== "string"
        || typeof resultado.contrasena !== "string"
        || (resultado.rutaDatos !== undefined && resultado.rutaDatos !== null && (
          typeof resultado.rutaDatos !== "string" || !resultado.rutaDatos.startsWith("/")
        ))
        || !/^[a-f0-9]{64}$/.test(resultado.contrasena)
      ) {
        return { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió datos de conexión inválidos." };
      }
      return resultado;
    },

    async eliminarBaseDatos({ id, motor, nombreConfirmado, nombreBaseDatos }) {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) {
        return { correcto: false, codigo: "identificador_invalido", mensaje: "Identificador de proyecto inválido." };
      }
      if (!MOTORES_BASES_DATOS.has(motor)) {
        return { correcto: false, codigo: "motor_no_permitido", mensaje: "El motor de base de datos no está permitido." };
      }
      if (typeof nombreConfirmado !== "string" || nombreConfirmado.trim().length < 2 || nombreConfirmado.length > 60) {
        return { correcto: false, codigo: "confirmacion_invalida", mensaje: "Escribe el nombre exacto del proyecto." };
      }
      const nombreBase = nombreBaseDatos ?? (motor === "redis" ? "0" : "swatt");
      if (motor === "redis" ? nombreBase !== "0" : typeof nombreBase !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(nombreBase)) {
        return { correcto: false, codigo: "nombre_base_invalido", mensaje: "El nombre de la base no es válido." };
      }
      const resultado = await enviarSolicitud({
        accion: "eliminar_base_datos",
        id,
        motor,
        nombreConfirmado,
        nombreBaseDatos: nombreBase,
      });
      if (
        resultado?.correcto !== true
        && (typeof resultado?.mensaje !== "string" || resultado.mensaje.length > 256)
      ) {
        return { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió una respuesta inválida." };
      }
      if (
        resultado.correcto !== true
        || resultado.nombre !== nombreConfirmado
      ) {
        return resultado.correcto === true
          ? { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió datos de borrado inválidos." }
          : resultado;
      }
      return resultado;
    },

    async ejecutarConsola({ id, nombreConfirmado, comando, directorio = "." }) {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) {
        return { correcto: false, codigo: "identificador_invalido", mensaje: "Identificador de proyecto inválido." };
      }
      if (
        typeof nombreConfirmado !== "string"
        || nombreConfirmado.trim().length < 2
        || nombreConfirmado.length > 60
      ) {
        return { correcto: false, codigo: "confirmacion_invalida", mensaje: "Nombre de proyecto inválido." };
      }
      if (
        typeof comando !== "string"
        || !comando.trim()
        || comando.length > 2048
        || comando.includes("\0")
      ) {
        return { correcto: false, codigo: "comando_invalido", mensaje: "El comando está vacío o supera 2048 caracteres." };
      }
      if (
        typeof directorio !== "string"
        || directorio.length > 512
        || directorio.startsWith("/")
        || directorio.includes("\0")
      ) {
        return { correcto: false, codigo: "directorio_invalido", mensaje: "La ruta debe permanecer dentro del proyecto." };
      }
      const resultado = await enviarSolicitud({
        accion: "consola_proyecto",
        id,
        nombreConfirmado,
        comando,
        directorio,
      });
      if (
        resultado?.correcto !== true
        && (typeof resultado?.mensaje !== "string" || resultado.mensaje.length > 256)
      ) {
        return { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió una respuesta inválida." };
      }
      if (resultado.correcto !== true) return resultado;
      if (
        typeof resultado.salida !== "string"
        || resultado.salida.length > 7000
        || !Number.isInteger(resultado.codigoSalida)
        || typeof resultado.directorio !== "string"
        || resultado.directorio.length > 512
        || typeof resultado.limiteTiempo !== "boolean"
        || typeof resultado.salidaRecortada !== "boolean"
      ) {
        return { correcto: false, codigo: "respuesta_agente_invalida", mensaje: "El agente devolvió una salida de consola inválida." };
      }
      return resultado;
    },

    async abrirTerminal({ id, nombreConfirmado, directorio = ".", columnas = 100, filas = 30 }) {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) {
        throw new Error("Identificador de proyecto inválido.");
      }
      if (typeof nombreConfirmado !== "string" || nombreConfirmado.trim().length < 2 || nombreConfirmado.length > 60) {
        throw new Error("Nombre de proyecto inválido.");
      }
      if (
        typeof directorio !== "string"
        || directorio.length > 512
        || directorio.startsWith("/")
        || directorio.includes("\0")
        || typeof columnas !== "number"
        || !Number.isInteger(columnas)
        || columnas < 20
        || columnas > 300
        || typeof filas !== "number"
        || !Number.isInteger(filas)
        || filas < 5
        || filas > 100
      ) {
        throw new Error("La configuración de terminal no es válida.");
      }
      return new Promise((resolver, rechazar) => {
        const conexion = net.createConnection(RUTA_SOCKET);
        let respuesta = Buffer.alloc(0);
        let finalizada = false;
        const tiempo = setTimeout(() => {
          finalizada = true;
          conexion.destroy();
          rechazar(new Error("El agente no inició la terminal a tiempo."));
        }, 600_000);
        conexion.once("connect", () => {
          conexion.write(`${JSON.stringify({
            accion: "terminal_proyecto",
            id,
            nombreConfirmado,
            directorio,
            columnas,
            filas,
          })}\n`);
        });
        const recibirConfirmacion = (fragmento) => {
          respuesta = Buffer.concat([respuesta, fragmento]);
          if (respuesta.length > 8192) {
            finalizada = true;
            clearTimeout(tiempo);
            conexion.off("data", recibirConfirmacion);
            conexion.destroy();
            rechazar(new Error("El agente devolvió una respuesta de terminal demasiado grande."));
            return;
          }
          const fin = respuesta.indexOf(10);
          if (fin < 0) return;
          clearTimeout(tiempo);
          conexion.off("data", recibirConfirmacion);
          let resultado;
          try {
            resultado = JSON.parse(respuesta.subarray(0, fin).toString("utf8"));
          } catch {
            finalizada = true;
            conexion.destroy();
            rechazar(new Error("El agente devolvió una respuesta de terminal inválida."));
            return;
          }
          if (
            resultado.correcto !== true
            || resultado.nombre !== nombreConfirmado
            || typeof resultado.directorio !== "string"
            || resultado.directorio.length > 512
            || resultado.directorio.startsWith("/")
            || resultado.directorio.includes("\0")
          ) {
            finalizada = true;
            conexion.destroy();
            rechazar(new Error(resultado.mensaje ?? "El agente rechazó la terminal."));
            return;
          }
          conexion.pause();
          finalizada = true;
          resolver({
            conexion,
            datosIniciales: respuesta.subarray(fin + 1),
            directorio: resultado.directorio,
          });
        };
        conexion.on("data", recibirConfirmacion);
        conexion.once("error", (error) => {
          clearTimeout(tiempo);
          if (!finalizada) {
            finalizada = true;
            rechazar(error);
          }
        });
        conexion.once("close", () => {
          clearTimeout(tiempo);
          if (!finalizada) {
            finalizada = true;
            rechazar(new Error("El agente cerró la conexión antes de iniciar la terminal."));
          }
        });
      });
    },
  });
}

export const servicioDocker = crearServicioDocker();
