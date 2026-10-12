// Gestiona la importación local de repositorios públicos sin ejecutar su contenido.
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile, lstat, readdir, open } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const ejecutarArchivo = promisify(execFile);
const NOMBRES_COMPOSE = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const MAXIMO_PROYECTOS = 25;
const MAXIMO_BYTES_REPOSITORIO = 268_435_456;
const MAXIMO_ARCHIVOS_REPOSITORIO = 25_000;
const MAXIMO_ARCHIVO_EDITABLE = 1_048_576;
const MAXIMO_ELEMENTOS_DIRECTORIO = 500;
const PUERTOS_BASES_DATOS = Object.freeze({
  postgresql: 5432,
  mariadb: 3306,
  mongodb: 27017,
  redis: 6379,
});
const PERFILES_RUNTIME = Object.freeze({
  html: { imagen: "nginx:1.27-alpine", puerto: 8080 },
  php: { imagen: "php:8.3-apache", puerto: 80 },
  node: { imagen: "node:22-bookworm-slim", puerto: 3000 },
  react: { imagen: "nginx:1.27-alpine", puerto: 8080 },
  python: { imagen: "python:3.12-slim", puerto: 8000 },
  ruby: { imagen: "ruby:3.3-slim", puerto: 3000 },
  java: { imagen: "eclipse-temurin:21-jre", puerto: 8080 },
  kotlin: { imagen: "eclipse-temurin:21-jre", puerto: 8080 },
  go: { imagen: "gcr.io/distroless/base-debian12:nonroot", puerto: 8080 },
  rust: { imagen: "gcr.io/distroless/cc-debian12:nonroot", puerto: 8080 },
});

// Rechaza credenciales u otros campos no previstos en el inventario público.
function baseDatosValida(proyecto) {
  const baseDatos = proyecto.baseDatos;
  if (baseDatos === undefined) return true;
  if (!baseDatos || typeof baseDatos !== "object" || Array.isArray(baseDatos)) return false;
  const campos = Object.keys(baseDatos).sort().join(",");
  const esperados = ["contenedor", "motor", "nombre", "puerto", "usuario", "volumen"].sort().join(",");
  const esperadosConRuta = ["contenedor", "motor", "nombre", "puerto", "rutaDatos", "usuario", "volumen"].sort().join(",");
  const sufijo = proyecto.id.replaceAll("-", "").slice(0, 12);
  const esRedis = baseDatos.motor === "redis";
  return (campos === esperados || (Object.hasOwn(baseDatos, "rutaDatos") && campos === esperadosConRuta))
    && Object.hasOwn(PUERTOS_BASES_DATOS, baseDatos.motor)
    && baseDatos.contenedor === `swatt-db-${sufijo}`
    && baseDatos.volumen === `swatt-dbdata-${sufijo}`
    && baseDatos.puerto === PUERTOS_BASES_DATOS[baseDatos.motor]
    && (esRedis
      ? baseDatos.nombre === "0"
      : typeof baseDatos.nombre === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(baseDatos.nombre))
    && (baseDatos.rutaDatos === undefined
      || (typeof baseDatos.rutaDatos === "string" && baseDatos.rutaDatos.startsWith("/") && baseDatos.rutaDatos.length <= 512))
    && baseDatos.usuario === "swatt";
}

// Devuelve errores HTTP controlados para entradas inválidas y conflictos.
function errorProyectos(codigo, mensaje, estado = 400) {
  const error = new Error(mensaje);
  error.codigo = codigo;
  error.estadoHttp = estado;
  return error;
}

// Acepta únicamente URLs HTTPS sin credenciales de GitHub o GitLab.
export function normalizarRepositorio(valor) {
  if (typeof valor !== "string" || valor.length > 300) {
    throw errorProyectos("repositorio_invalido", "Escribe una URL pública válida de GitHub o GitLab.");
  }

  let url;
  try {
    url = new URL(valor.trim());
  } catch {
    throw errorProyectos("repositorio_invalido", "Escribe una URL pública válida de GitHub o GitLab.");
  }

  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || !["github.com", "gitlab.com"].includes(host)
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || /[%\\\u0000-\u0020]/.test(url.pathname)
  ) {
    throw errorProyectos("repositorio_no_permitido", "Solo se permiten repositorios HTTPS públicos de github.com o gitlab.com.");
  }

  const partes = url.pathname.replace(/\/+$/, "").slice(1).split("/");
  if (partes.some((parte) => !/^[A-Za-z0-9_.-]{1,100}$/.test(parte) || parte === "." || parte === "..")) {
    throw errorProyectos("repositorio_invalido", "La ruta del repositorio no es válida.");
  }
  const esGithub = host === "github.com";
  if ((esGithub && partes.length !== 2) || (!esGithub && partes.length < 2)) {
    throw errorProyectos("repositorio_invalido", "Indica el repositorio, no una página de usuario o grupo.");
  }

  const nombreRepositorio = partes.at(-1).replace(/\.git$/i, "");
  if (!nombreRepositorio || nombreRepositorio === "." || nombreRepositorio === "..") {
    throw errorProyectos("repositorio_invalido", "El nombre del repositorio no es válido.");
  }
  partes[partes.length - 1] = nombreRepositorio;
  return `https://${host}/${partes.join("/")}.git`;
}

// Restringe el nombre visible y la rama a valores simples, sin rutas ni opciones Git.
function validarSolicitud(solicitud) {
  if (!solicitud || typeof solicitud !== "object" || Array.isArray(solicitud)) {
    throw errorProyectos("solicitud_invalida", "La información del proyecto no es válida.");
  }
  const nombre = typeof solicitud.nombre === "string" ? solicitud.nombre.trim() : "";
  const rama = typeof solicitud.rama === "string" ? solicitud.rama.trim() : "";
  if (nombre.length < 2 || nombre.length > 60 || /[\u0000-\u001f/\\]/.test(nombre)) {
    throw errorProyectos("nombre_invalido", "El nombre debe tener entre 2 y 60 caracteres y no incluir rutas.");
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(rama)
    || rama.includes("..")
    || rama.includes("//")
    || rama.endsWith("/")
    || rama.endsWith(".")
    || rama.includes("@{")
    || rama.split("/").some((parte) => parte.startsWith(".") || parte.endsWith(".lock"))
  ) {
    throw errorProyectos("rama_invalida", "La rama indicada no tiene un formato Git permitido.");
  }
  return {
    nombre,
    rama,
    repositorio: normalizarRepositorio(solicitud.repositorio),
  };
}

// Ejecuta Git sin shell, sin hooks ni credenciales y con un límite de tiempo.
async function clonarRepositorio(repositorio, rama, destino) {
  const valorNulo = process.platform === "win32" ? "NUL" : "/dev/null";
  const entornoGit = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: valorNulo,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "https",
  };
  const opciones = { timeout: 120_000, maxBuffer: 1024 * 1024, env: entornoGit };
  await ejecutarArchivo("git", [
    "-c", `core.hooksPath=${valorNulo}`,
    "-c", "http.followRedirects=false",
    "clone", "--depth", "1", "--single-branch", "--no-tags", "--no-recurse-submodules",
    "--branch", rama, "--", repositorio, destino,
  ], opciones);
  const { stdout } = await ejecutarArchivo(
    "git",
    ["-C", destino, "rev-parse", "--short=12", "HEAD"],
    opciones,
  );
  return stdout.trim();
}

// Enumera solo archivos Compose normales situados en la raíz del repositorio.
async function encontrarArchivosCompose(directorio) {
  const encontrados = [];
  for (const nombre of NOMBRES_COMPOSE) {
    try {
      const metadatos = await lstat(path.join(directorio, nombre));
      if (metadatos.isFile()) encontrados.push(nombre);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return encontrados;
}

// Retira los metadatos Git para que Apache no pueda servirlos desde la raíz web.
async function retirarMetadatosGit(directorio) {
  const rutaGit = path.join(directorio, ".git");
  try {
    await lstat(rutaGit);
    await rm(rutaGit, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// Rechaza repositorios demasiado grandes antes de conservarlos en el servidor.
async function validarTamanoRepositorio(directorio) {
  const pendientes = [directorio];
  let bytes = 0;
  let archivos = 0;
  while (pendientes.length > 0) {
    const actual = pendientes.pop();
    const elementos = await readdir(actual, { withFileTypes: true });
    for (const elemento of elementos) {
      const ruta = path.join(actual, elemento.name);
      const metadatos = await lstat(ruta);
      archivos += 1;
      bytes += metadatos.size;
      if (bytes > MAXIMO_BYTES_REPOSITORIO || archivos > MAXIMO_ARCHIVOS_REPOSITORIO) {
        throw errorProyectos(
          "repositorio_demasiado_grande",
          "El repositorio supera el límite de 256 MiB o 25 000 elementos.",
          413,
        );
      }
      if (metadatos.isDirectory()) pendientes.push(ruta);
    }
  }
}

// Crea un servicio aislable en pruebas y con almacenamiento persistente en producción.
export function crearServicioProyectos({
  directorio = process.env.DIRECTORIO_PROYECTOS ?? path.resolve("proyectos"),
  clonar = clonarRepositorio,
} = {}) {
  const raiz = path.resolve(directorio);
  const archivoRegistro = path.join(raiz, ".registro-swatt.json");
  let importacionActiva = false;

  function rutaProyecto(id) {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) {
      throw errorProyectos("identificador_invalido", "Identificador de proyecto inválido.");
    }
    return path.join(raiz, id);
  }

  async function rutaSegura(id, rutaRelativa = "") {
    const raizProyecto = rutaProyecto(id);
    const destino = path.resolve(raizProyecto, rutaRelativa);
    if (destino !== raizProyecto && !destino.startsWith(`${raizProyecto}${path.sep}`)) {
      throw errorProyectos("ruta_invalida", "La ruta debe permanecer dentro del proyecto.");
    }
    const metadatosProyecto = await lstat(raizProyecto);
    if (!metadatosProyecto.isDirectory() || metadatosProyecto.isSymbolicLink()) {
      throw errorProyectos("proyecto_no_disponible", "La carpeta del proyecto no está disponible.", 404);
    }
    let actual = raizProyecto;
    for (const segmento of path.relative(raizProyecto, destino).split(path.sep).filter(Boolean)) {
      actual = path.join(actual, segmento);
      try {
        const metadatos = await lstat(actual);
        if (metadatos.isSymbolicLink()) {
          throw errorProyectos("enlace_no_permitido", "No se admiten enlaces simbólicos en el gestor de archivos.");
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return destino;
  }

  async function obtenerProyectoAutorizado(id, cuenta) {
    const registro = await leerRegistro();
    const proyecto = registro.find((elemento) => elemento.id === id);
    if (
      !proyecto
      || (cuenta?.rol !== "administrador" && proyecto.propietarioId !== cuenta?.id)
    ) {
      throw errorProyectos("proyecto_no_encontrado", "No se encontró el proyecto.", 404);
    }
    return { registro, proyecto };
  }

  async function leerRegistro() {
    try {
      const contenido = await readFile(archivoRegistro, "utf8");
      const registro = JSON.parse(contenido);
      if (
        !Array.isArray(registro)
        || registro.some((proyecto) => (
          !proyecto
          || typeof proyecto !== "object"
          || !/^[a-f0-9-]{36}$/i.test(proyecto.id)
          || typeof proyecto.nombre !== "string"
          || (proyecto.propietarioId !== undefined && typeof proyecto.propietarioId !== "string")
          || typeof proyecto.rama !== "string"
          || typeof proyecto.commit !== "string"
          || !Array.isArray(proyecto.archivosCompose)
          || proyecto.archivosCompose.some((archivo) => !NOMBRES_COMPOSE.includes(archivo))
          || !["pendiente_revision", "desplegado", "archivado"].includes(proyecto.estado)
          || (proyecto.estado === "desplegado" && (
            !PERFILES_RUNTIME[proyecto.runtimePerfil ?? "php"]
            || proyecto.runtime !== PERFILES_RUNTIME[proyecto.runtimePerfil ?? "php"].imagen
            || !Number.isInteger(proyecto.puertoLocal)
            || proyecto.puertoLocal < 18080
            || proyecto.puertoLocal > 18179
            || (proyecto.puertoInterno ?? PERFILES_RUNTIME[proyecto.runtimePerfil ?? "php"].puerto)
              !== PERFILES_RUNTIME[proyecto.runtimePerfil ?? "php"].puerto
            || proyecto.contenedor !== `swatt-${(proyecto.runtimePerfil ?? "php") === "php" ? "php" : "app"}-${proyecto.id.replaceAll("-", "").slice(0, 12)}`
            || !["activo", "detenido", "no_disponible"].includes(proyecto.estadoRuntime ?? "activo")
          ))
          || !baseDatosValida(proyecto)
          || typeof proyecto.creado !== "string"
          || normalizarRepositorio(proyecto.repositorio) !== proyecto.repositorio
        ))
      ) {
        throw new Error("El registro contiene información de proyecto inválida.");
      }
      return registro;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("No se pudo leer el registro de proyectos.", { cause: error });
    }
  }

  async function guardarRegistro(registro) {
    const temporal = path.join(raiz, `.registro-${randomUUID()}.tmp`);
    try {
      const actual = await leerRegistro();
      const idsActuales = new Set(actual.map((proyecto) => proyecto.id));
      const combinado = [
        ...actual,
        ...registro.filter((proyecto) => !idsActuales.has(proyecto.id)),
      ];
      await writeFile(temporal, JSON.stringify(combinado, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporal, archivoRegistro);
    } catch (error) {
      await rm(temporal, { force: true }).catch((errorTemporal) => {
        console.error("No se pudo retirar el archivo temporal del registro:", errorTemporal.message);
      });
      throw error;
    }
  }

  async function guardarRegistroCompleto(registro) {
    const temporal = path.join(raiz, `.registro-${randomUUID()}.tmp`);
    try {
      await writeFile(temporal, `${JSON.stringify(registro, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporal, archivoRegistro);
    } catch (error) {
      await rm(temporal, { force: true }).catch((errorTemporal) => {
        console.error("No se pudo retirar el archivo temporal del registro:", errorTemporal.message);
      });
      throw error;
    }
  }

  return Object.freeze({
    async listar(cuenta = null) {
      await mkdir(raiz, { recursive: true, mode: 0o750 });
      const registro = await leerRegistro();
      const visibles = registro.filter((proyecto) => (
        cuenta?.rol === "administrador" || proyecto.propietarioId === cuenta?.id
      ));
      return Promise.all(visibles.map(async (proyecto) => {
        const { propietarioId: _propietarioId, ...proyectoVisible } = proyecto;
        if (proyecto.estado !== "pendiente_revision") {
          return { ...proyectoVisible, puedeDesplegar: false };
        }
        return { ...proyectoVisible, puedeDesplegar: true };
      }));
    },

    async leerCompose(id, nombreArchivo, cuenta = null) {
      if (!NOMBRES_COMPOSE.includes(nombreArchivo)) {
        throw errorProyectos("archivo_compose_invalido", "El archivo Compose solicitado no está permitido.");
      }
      const { proyecto } = await obtenerProyectoAutorizado(id, cuenta);
      if (!proyecto.archivosCompose.includes(nombreArchivo)) {
        throw errorProyectos("archivo_compose_no_encontrado", "No se encontró ese archivo Compose en el proyecto.", 404);
      }
      const ruta = await rutaSegura(proyecto.id, nombreArchivo);
      const metadatos = await lstat(ruta).catch((error) => {
        if (error.code === "ENOENT") {
          throw errorProyectos("archivo_compose_no_encontrado", "No se encontró ese archivo Compose en el proyecto.", 404);
        }
        throw error;
      });
      if (!metadatos.isFile()) {
        throw errorProyectos("archivo_compose_no_encontrado", "No se encontró ese archivo Compose en el proyecto.", 404);
      }
      if (metadatos.size > 262_144) {
        throw errorProyectos("archivo_compose_demasiado_grande", "El archivo Compose supera el límite de lectura de 256 KiB.", 413);
      }
      return { nombre: nombreArchivo, contenido: await readFile(ruta, "utf8") };
    },

    async listarArchivos(id, ruta, cuenta) {
      await obtenerProyectoAutorizado(id, cuenta);
      const destino = await rutaSegura(id, ruta ?? "");
      const elementos = await readdir(destino, { withFileTypes: true });
      if (elementos.length > MAXIMO_ELEMENTOS_DIRECTORIO) {
        throw errorProyectos("directorio_demasiado_grande", "La carpeta contiene demasiados elementos.", 413);
      }
      return Promise.all(elementos.map(async (elemento) => {
        const rutaElemento = path.join(destino, elemento.name);
        const metadatos = await lstat(rutaElemento);
        return {
          nombre: elemento.name,
          tipo: metadatos.isDirectory() ? "directorio" : metadatos.isFile() ? "archivo" : "otro",
          bytes: metadatos.size,
        };
      }));
    },

    async leerArchivo(id, ruta, cuenta) {
      await obtenerProyectoAutorizado(id, cuenta);
      if (typeof ruta !== "string" || !ruta.trim()) {
        throw errorProyectos("ruta_invalida", "Indica el archivo que quieres abrir.");
      }
      const destino = await rutaSegura(id, ruta);
      const metadatos = await lstat(destino);
      if (!metadatos.isFile()) {
        throw errorProyectos("archivo_invalido", "Solo se pueden abrir archivos normales.");
      }
      if (metadatos.size > MAXIMO_ARCHIVO_EDITABLE) {
        throw errorProyectos("archivo_demasiado_grande", "El editor admite archivos de hasta 1 MiB.", 413);
      }
      const contenido = await readFile(destino);
      if (contenido.includes(0)) {
        throw errorProyectos("archivo_binario", "Este archivo parece binario y no se puede editar como texto.");
      }
      return { ruta, contenido: contenido.toString("utf8") };
    },

    async guardarArchivo(id, ruta, contenido, cuenta, contenidoBase64 = undefined) {
      await obtenerProyectoAutorizado(id, cuenta);
      if (typeof ruta !== "string" || !ruta.trim()) {
        throw errorProyectos("archivo_invalido", "Indica una ruta y contenido de hasta 1 MiB.", 413);
      }
      let contenidoArchivo;
      if (typeof contenido === "string" && contenidoBase64 === undefined) {
        contenidoArchivo = Buffer.from(contenido, "utf8");
        if (contenido.includes("\0")) {
          throw errorProyectos("archivo_binario", "El editor de texto no admite bytes nulos.");
        }
      } else if (
        contenido === undefined
        && typeof contenidoBase64 === "string"
        && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contenidoBase64)
      ) {
        contenidoArchivo = Buffer.from(contenidoBase64, "base64");
        if (contenidoArchivo.toString("base64") !== contenidoBase64) {
          throw errorProyectos("archivo_invalido", "El contenido binario no tiene un formato válido.");
        }
      } else {
        throw errorProyectos("archivo_invalido", "Indica contenido de texto o un archivo binario válido.");
      }
      if (contenidoArchivo.byteLength > MAXIMO_ARCHIVO_EDITABLE) {
        throw errorProyectos("archivo_invalido", "El tamaño máximo por archivo es 1 MiB.", 413);
      }
      const destino = await rutaSegura(id, ruta);
      await mkdir(path.dirname(destino), { recursive: true, mode: 0o755 });
      const temporal = `${destino}.${randomUUID()}.tmp`;
      const descriptor = await open(temporal, "wx", 0o644);
      try {
        await descriptor.writeFile(contenidoArchivo);
        await descriptor.close();
        await rename(temporal, destino);
      } catch (error) {
        await descriptor.close().catch(() => {});
        await rm(temporal, { force: true }).catch(() => {});
        throw error;
      }
      return { ruta, bytes: contenidoArchivo.byteLength };
    },

    async crearDirectorio(id, ruta, cuenta) {
      await obtenerProyectoAutorizado(id, cuenta);
      if (typeof ruta !== "string" || !ruta.trim()) {
        throw errorProyectos("ruta_invalida", "Indica el nombre de la carpeta.");
      }
      await mkdir(await rutaSegura(id, ruta), { recursive: false, mode: 0o750 });
      return { ruta };
    },

    async eliminarArchivo(id, ruta, cuenta) {
      await obtenerProyectoAutorizado(id, cuenta);
      if (typeof ruta !== "string" || !ruta.trim()) {
        throw errorProyectos("ruta_invalida", "Indica el archivo o carpeta que quieres borrar.");
      }
      const destino = await rutaSegura(id, ruta);
      const metadatos = await lstat(destino);
      if (metadatos.isDirectory()) {
        await rm(destino, { recursive: true });
      } else if (metadatos.isFile()) {
        await rm(destino);
      } else {
        throw errorProyectos("archivo_invalido", "No se pueden borrar enlaces o elementos especiales.");
      }
      return { ruta };
    },

    async obtener(id, cuenta) {
      const { proyecto } = await obtenerProyectoAutorizado(id, cuenta);
      return proyecto;
    },

    async eliminarProyecto(id, cuenta) {
      const { registro, proyecto } = await obtenerProyectoAutorizado(id, cuenta);
      if (proyecto.estado !== "archivado") {
        throw errorProyectos("proyecto_no_archivado", "Prepara primero el runtime para borrar el proyecto.", 409);
      }
      const carpeta = rutaProyecto(id);
      try {
        const metadatos = await lstat(carpeta);
        if (!metadatos.isDirectory() || metadatos.isSymbolicLink()) {
          throw errorProyectos("carpeta_invalida", "La carpeta del proyecto no es segura.");
        }
        await rm(carpeta, { recursive: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const siguienteRegistro = registro.filter((elemento) => elemento.id !== id);
      if (proyecto.baseDatos) {
        const archivado = { ...proyecto, estado: "archivado" };
        for (const campo of [
          "runtime", "runtimePerfil", "puertoInterno", "puertoLocal",
          "contenedor", "idContenedor", "estadoRuntime",
        ]) {
          delete archivado[campo];
        }
        siguienteRegistro.push(archivado);
      }
      await guardarRegistroCompleto(siguienteRegistro);
      return { proyecto: proyecto.nombre, baseDatosConservada: Boolean(proyecto.baseDatos) };
    },

    async eliminarBaseArchivada(id, cuenta) {
      const { registro, proyecto } = await obtenerProyectoAutorizado(id, cuenta);
      if (proyecto.estado !== "archivado" || !proyecto.baseDatos) {
        throw errorProyectos("base_archivada_no_encontrada", "No hay una base archivada para eliminar.", 404);
      }
      await guardarRegistroCompleto(registro.filter((elemento) => elemento.id !== id));
      return { proyecto: proyecto.nombre };
    },

    async importar(solicitud, propietarioId) {
      const datos = validarSolicitud(solicitud);
      if (typeof propietarioId !== "string" || !propietarioId) {
        throw errorProyectos("propietario_invalido", "No se pudo determinar la cuenta propietaria.", 401);
      }
      if (importacionActiva) {
        throw errorProyectos("importacion_en_curso", "Ya hay una importación en curso. Inténtalo de nuevo en un momento.", 409);
      }
      importacionActiva = true;
      let destino;
      try {
        await mkdir(raiz, { recursive: true, mode: 0o750 });
        const registro = await leerRegistro();
        if (registro.length >= MAXIMO_PROYECTOS) {
          throw errorProyectos("limite_proyectos", `El panel admite hasta ${MAXIMO_PROYECTOS} proyectos importados.`, 409);
        }
        if (registro.some((proyecto) => proyecto.nombre.toLocaleLowerCase("es") === datos.nombre.toLocaleLowerCase("es"))) {
          throw errorProyectos("nombre_duplicado", "Ya existe un proyecto con ese nombre.", 409);
        }
        if (registro.some((proyecto) => proyecto.repositorio === datos.repositorio)) {
          throw errorProyectos("repositorio_duplicado", "Ese repositorio ya está importado.", 409);
        }

        const id = randomUUID();
        destino = path.join(raiz, id);
        const commit = await clonar(datos.repositorio, datos.rama, destino);
        await validarTamanoRepositorio(destino);
        await retirarMetadatosGit(destino);
        const archivosCompose = await encontrarArchivosCompose(destino);
        const proyecto = {
          id,
          propietarioId,
          nombre: datos.nombre,
          repositorio: datos.repositorio,
          rama: datos.rama,
          commit,
          archivosCompose,
          estado: "pendiente_revision",
          creado: new Date().toISOString(),
        };
        await guardarRegistro([...registro, proyecto]);
        return proyecto;
      } catch (error) {
        if (destino) {
          await rm(destino, { recursive: true, force: true }).catch((errorLimpieza) => {
            console.error("No se pudo limpiar el directorio incompleto del proyecto:", errorLimpieza.message);
          });
        }
        if (error.codigo) throw error;
        throw new Error("No se pudo importar el repositorio. Comprueba la URL, la rama y la conexión del servidor.", {
          cause: error,
        });
      } finally {
        importacionActiva = false;
      }
    },
  });
}

export const servicioProyectos = crearServicioProyectos();
