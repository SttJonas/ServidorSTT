// Selecciona los elementos que cambian cuando el usuario navega por el panel.
const botonesNavegacion = document.querySelectorAll(".enlace-navegacion");
const seccionesContenido = document.querySelectorAll(".contenido-seccion");
const tituloSeccion = document.querySelector("#titulo-seccion");
const barraLateral = document.querySelector("#barra-lateral");
const avisoTitulo = document.querySelector("#aviso-titulo");
const avisoMensaje = document.querySelector("#aviso-mensaje");
let ultimoDocker = null;
let accionDockerPendiente = null;
let proyectoPhpPendiente = null;
let proyectoBaseDatosPendiente = null;
let gestionProyectoPendiente = null;
let operacionBaseDatosActiva = false;
let ultimoEstadoHost = null;
let estadoHostConectado = false;
let sesionActual = null;
const seccionesAdministracion = new Set(["mantenimiento", "usuarios"]);
const ETIQUETAS_RUNTIME = {
  html: "HTML estático",
  php: "PHP/Apache",
  node: "Node.js",
  react: "React",
  python: "Python",
  ruby: "Ruby",
  java: "Java",
  kotlin: "Kotlin",
  go: "Go",
  rust: "Rust",
};
const CATALOGO_RUNTIME = [
  ["html", "HTML estático", "Publica archivos estáticos sin fase de compilación."],
  ["php", "PHP", "Aplicaciones PHP servidas por Apache."],
  ["node", "Node.js", "Aplicaciones JavaScript del lado del servidor."],
  ["react", "React", "Aplicaciones React compiladas para producción."],
  ["python", "Python", "Aplicaciones Python con perfil administrado."],
  ["ruby", "Ruby", "Aplicaciones Ruby con perfil administrado."],
  ["java", "Java", "Aplicaciones Java con perfil administrado."],
  ["kotlin", "Kotlin", "Aplicaciones Kotlin con perfil administrado."],
  ["go", "Go", "Aplicaciones compiladas con Go."],
  ["rust", "Rust", "Aplicaciones compiladas con Rust."],
];
const CATALOGO_BASES_DATOS = [
  ["PostgreSQL", "Relacional", "Motor SQL para datos estructurados."],
  ["MariaDB", "Relacional", "Motor SQL compatible con MySQL."],
  ["MongoDB", "Documentos", "Base de datos orientada a documentos."],
  ["Redis", "Clave-valor", "Almacén en memoria para datos y caché."],
];

// Presenta la fecha local en español y mantiene el saludo ligado al host real.
document.querySelector("#fecha-actual").textContent = new Intl.DateTimeFormat("es", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
}).format(new Date()).toLocaleUpperCase("es");

// Obtiene únicamente el texto de la opción y evita copiar el símbolo visual.
function obtenerNombreSeccion(boton) {
  return Array.from(boton.childNodes)
    .filter((nodo) => nodo.nodeType === Node.TEXT_NODE)
    .map((nodo) => nodo.textContent.trim())
    .join(" ");
}

// Cambia entre las vistas implementadas y carga los datos necesarios al abrirlas.
botonesNavegacion.forEach((boton) => {
  boton.addEventListener("click", () => {
    botonesNavegacion.forEach((elemento) => elemento.classList.remove("activo"));
    boton.classList.add("activo");
    const seccion = boton.dataset.seccion;
    const esResumen = seccion === "resumen";
    const nombreSeccion = obtenerNombreSeccion(boton).trim();
    tituloSeccion.textContent = esResumen ? "Resumen del servidor" : nombreSeccion;
    document.querySelector("#migas-seccion").textContent = nombreSeccion;
    document.title = `Swatt | ${esResumen ? "Resumen del servidor" : nombreSeccion}`;
    const esDocker = seccion === "docker";
    const esProyectos = seccion === "proyectos";
    for (const seccionContenido of seccionesContenido) {
      seccionContenido.hidden = seccionContenido.id !== `seccion-${seccion}`;
    }
    barraLateral.classList.remove("abierta");
    if (esDocker) document.querySelector("#buscar-contenedor").focus();
    if (esProyectos) {
      document.querySelector("#proyecto-nombre").focus();
      actualizarProyectos();
    }
    if (seccion === "tecnologias") actualizarTecnologias();
    if (seccion === "terminal" || seccion === "archivos") actualizarProyectos();
    if (seccion === "mantenimiento") actualizarEstadoDeFormaSegura();
    if (seccion === "usuarios") actualizarSesion();
  });
});

// Construye una tarjeta de proyecto únicamente con nodos y texto seguro.
function crearTarjetaProyecto(proyecto) {
  const tarjeta = document.createElement("article");
  tarjeta.className = "proyecto-tarjeta";
  const encabezado = document.createElement("div");
  encabezado.className = "proyecto-tarjeta-encabezado";
  const nombre = document.createElement("strong");
  nombre.textContent = proyecto.nombre;
  const estado = document.createElement("span");
  estado.className = "proyecto-estado";
  if (proyecto.estado === "archivado") {
    estado.textContent = "Aplicación archivada";
    encabezado.append(nombre, estado);
    tarjeta.append(encabezado);
    const detalleArchivado = document.createElement("p");
    detalleArchivado.className = "proyecto-despliegue";
    detalleArchivado.textContent = proyecto.baseDatos
      ? `El código y el runtime se eliminaron. La base ${proyecto.baseDatos.motor} sigue archivada y conserva sus datos.`
      : "El código y el runtime de esta aplicación se eliminaron.";
    tarjeta.append(detalleArchivado);
    if (proyecto.baseDatos) {
      const botonEliminarBase = document.createElement("button");
      botonEliminarBase.type = "button";
      botonEliminarBase.className = "boton-accion-proyecto boton-accion-proyecto-peligro";
      botonEliminarBase.dataset.gestionProyecto = "eliminar-base";
      botonEliminarBase.dataset.proyectoId = proyecto.id;
      botonEliminarBase.dataset.proyectoNombre = proyecto.nombre;
      botonEliminarBase.dataset.nombreBaseDatos = proyecto.baseDatos.nombre;
      botonEliminarBase.textContent = "Eliminar base permanentemente";
      tarjeta.append(botonEliminarBase);
    }
    return tarjeta;
  }
  const perfil = proyecto.runtimePerfil ?? "php";
  const etiquetaRuntime = ETIQUETAS_RUNTIME[perfil] ?? "Aplicación";
  const estadoRuntime = proyecto.estadoRuntime ?? "activo";
  estado.textContent = proyecto.estado !== "desplegado"
    ? "Pendiente de revisión"
    : estadoRuntime === "activo"
      ? `${etiquetaRuntime} activo`
      : estadoRuntime === "detenido"
        ? `${etiquetaRuntime} detenido`
        : `${etiquetaRuntime} no disponible`;
  encabezado.append(nombre, estado);

  const repositorio = document.createElement("p");
  repositorio.className = "proyecto-repositorio";
  repositorio.textContent = proyecto.repositorio;
  const detalles = document.createElement("div");
  detalles.className = "proyecto-detalles";
  const rama = document.createElement("span");
  rama.textContent = `Rama: ${proyecto.rama}`;
  const commit = document.createElement("span");
  commit.textContent = `Commit: ${proyecto.commit}`;
  detalles.append(rama, commit);
  if (proyecto.rutaProyecto) {
    const ruta = document.createElement("span");
    ruta.className = "proyecto-ruta";
    ruta.textContent = `Código editable: ${proyecto.rutaProyecto}${proyecto.rutaRuntime && proyecto.rutaRuntime !== proyecto.rutaProyecto
      ? ` · runtime administrado: ${proyecto.rutaRuntime}`
      : ""}`;
    detalles.append(ruta);
  }

  const compose = document.createElement("p");
  compose.className = "proyecto-compose";
  if (proyecto.archivosCompose.length) {
    compose.textContent = "Revisa estos archivos antes de cualquier despliegue:";
    const archivos = document.createElement("div");
    archivos.className = "proyecto-archivos-compose";
    for (const archivo of proyecto.archivosCompose) {
      const boton = document.createElement("button");
      boton.type = "button";
      boton.className = "boton-ver-compose";
      boton.dataset.proyectoId = proyecto.id;
      boton.dataset.archivoCompose = archivo;
      boton.textContent = `Ver ${archivo}`;
      archivos.append(boton);
    }
    tarjeta.append(encabezado, repositorio, detalles, compose, archivos);
  } else {
    compose.textContent = "No se encontró un archivo Compose en la Raíz";
    tarjeta.append(encabezado, repositorio, detalles, compose);
  }

  const despliegue = document.createElement("p");
  despliegue.className = "proyecto-despliegue";
  const rutaInicio = proyecto.rutaInicio
    ? `/${proyecto.rutaInicio.split("/").map(encodeURIComponent).join("/")}`
    : "/";
  if (proyecto.estado === "desplegado") {
    despliegue.textContent = estadoRuntime === "activo"
      ? `${etiquetaRuntime} activo · 127.0.0.1:${proyecto.puertoLocal}`
      : estadoRuntime === "detenido"
        ? `${etiquetaRuntime} detenido · Puerto reservado 127.0.0.1:${proyecto.puertoLocal}`
        : `${etiquetaRuntime} no disponible · Último puerto 127.0.0.1:${proyecto.puertoLocal}`;
    tarjeta.append(despliegue);
    if (estadoRuntime === "activo") {
      const acceso = document.createElement("p");
      acceso.className = "proyecto-compose";
      if (proyecto.urlPrivada) {
        acceso.textContent = "Acceso privado disponible para dispositivos conectados a la misma red Tailscale.";
        const enlace = document.createElement("a");
        enlace.className = "enlace-acceso-tailnet";
        enlace.href = `${proyecto.urlPrivada}${rutaInicio}`;
        enlace.target = "_blank";
        enlace.rel = "noopener noreferrer";
        enlace.textContent = "Abrir aplicación en Tailscale";
        tarjeta.append(acceso, enlace);
      } else {
        acceso.textContent =
          `Vista previa privada: abre un túnel SSH y visita http://127.0.0.1:${proyecto.puertoLocal} en tu equipo.`;
        const tunel = document.createElement("button");
        tunel.type = "button";
        tunel.className = "boton-tunel-ssh";
        tunel.dataset.comandoTunel =
          `ssh -L ${proyecto.puertoLocal}:127.0.0.1:${proyecto.puertoLocal} usuario@servidor`;
        tunel.textContent = "Copiar comando del túnel";
        const vistaPrevia = document.createElement("p");
        vistaPrevia.className = "proyecto-despliegue";
        vistaPrevia.textContent = `Después de abrir el túnel, visita http://127.0.0.1:${proyecto.puertoLocal}${rutaInicio}`;
        tarjeta.append(acceso, tunel, vistaPrevia);
      }
    }
    const accionesProyecto = document.createElement("div");
    accionesProyecto.className = "acciones-proyecto-php";
    const accionesPermitidas = estadoRuntime === "activo"
      ? [["reiniciar", "Reiniciar"], ["detener", "Detener"]]
      : estadoRuntime === "detenido"
        ? [["iniciar", "Iniciar"], ["reiniciar", "Reiniciar"]]
        : [["iniciar", "Intentar iniciar"]];
    for (const [accion, etiqueta] of accionesPermitidas) {
      const boton = document.createElement("button");
      boton.type = "button";
      boton.className = `boton-accion-php accion-php-${accion}`;
      boton.dataset.accionPhp = accion;
      boton.dataset.proyectoId = proyecto.id;
      boton.dataset.proyectoNombre = proyecto.nombre;
      boton.textContent = etiqueta;
      accionesProyecto.append(boton);
    }
    tarjeta.append(accionesProyecto);
    const accionesGestion = document.createElement("div");
    accionesGestion.className = "acciones-proyecto-php";
    const botonActualizar = document.createElement("button");
    botonActualizar.type = "button";
    botonActualizar.className = "boton-accion-proyecto";
    botonActualizar.dataset.gestionProyecto = "actualizar";
    botonActualizar.dataset.proyectoId = proyecto.id;
    botonActualizar.dataset.proyectoNombre = proyecto.nombre;
    botonActualizar.textContent = estadoRuntime === "no_disponible"
      ? "Intentar reparar / actualizar"
      : "Aplicar cambios / recompilar";
    const botonEliminar = document.createElement("button");
    botonEliminar.type = "button";
    botonEliminar.className = "boton-accion-proyecto boton-accion-proyecto-peligro";
    botonEliminar.dataset.gestionProyecto = "eliminar-app";
    botonEliminar.dataset.proyectoId = proyecto.id;
    botonEliminar.dataset.proyectoNombre = proyecto.nombre;
    botonEliminar.textContent = "Eliminar app";
    accionesGestion.append(botonActualizar, botonEliminar);
    tarjeta.append(accionesGestion);
    if (proyecto.baseDatos) {
      const estadoBaseDatos = document.createElement("p");
      estadoBaseDatos.className = "proyecto-despliegue";
      estadoBaseDatos.textContent =
        `${proyecto.baseDatos.motor} · ${proyecto.baseDatos.nombre} · base-datos:${proyecto.baseDatos.puerto} · datos: ${proyecto.baseDatos.rutaDatos ?? "volumen Docker persistente"}`;
      tarjeta.append(estadoBaseDatos);
      const botonCredenciales = document.createElement("button");
      botonCredenciales.type = "button";
      botonCredenciales.className = "boton-desplegar-php";
      botonCredenciales.dataset.accionCredencialesBaseDatos = "mostrar";
      botonCredenciales.dataset.proyectoId = proyecto.id;
      botonCredenciales.dataset.proyectoNombre = proyecto.nombre;
      botonCredenciales.dataset.motorBaseDatos = proyecto.baseDatos.motor;
      botonCredenciales.dataset.nombreBaseDatos = proyecto.baseDatos.nombre;
      botonCredenciales.dataset.rutaProyecto = proyecto.rutaProyecto ?? "";
      botonCredenciales.textContent = "Mostrar conexión";
      tarjeta.append(botonCredenciales);
    } else if (estadoRuntime === "activo") {
      const botonBaseDatos = document.createElement("button");
      botonBaseDatos.type = "button";
      botonBaseDatos.className = "boton-desplegar-php";
      botonBaseDatos.dataset.accionBaseDatos = "crear";
      botonBaseDatos.dataset.proyectoId = proyecto.id;
      botonBaseDatos.dataset.proyectoNombre = proyecto.nombre;
      botonBaseDatos.dataset.rutaProyecto = proyecto.rutaProyecto ?? "";
      botonBaseDatos.textContent = "Añadir base de datos";
      tarjeta.append(botonBaseDatos);
    }
  } else if (proyecto.estado === "pendiente_revision") {
    const botonDespliegue = document.createElement("button");
    botonDespliegue.type = "button";
    botonDespliegue.className = "boton-desplegar-php";
    botonDespliegue.dataset.proyectoId = proyecto.id;
    botonDespliegue.dataset.proyectoNombre = proyecto.nombre;
    botonDespliegue.textContent = "Configurar despliegue";
    tarjeta.append(botonDespliegue);
  }
  return tarjeta;
}

// Representa la lista completa y los proyectos recientes sin interpretar HTML.
function mostrarProyectos(proyectos) {
  const lista = document.querySelector("#lista-proyectos");
  const resumen = document.querySelector("#resumen-proyectos-lista");
  const vacio = document.querySelector("#resumen-proyectos-vacio");
  lista.replaceChildren();
  resumen.replaceChildren();
  actualizarSelectoresProyectos(proyectos);
  mostrarTecnologiasActivas(proyectos);
  vacio.hidden = proyectos.length > 0;
  resumen.hidden = proyectos.length === 0;

  if (proyectos.length === 0) {
    const mensaje = document.createElement("p");
    mensaje.className = "proyectos-vacio";
    mensaje.textContent = "Aún no hay repositorios importados.";
    lista.append(mensaje);
    return;
  }
  for (const proyecto of proyectos) lista.append(crearTarjetaProyecto(proyecto));
  for (const proyecto of proyectos.slice(-3).reverse()) resumen.append(crearTarjetaProyecto(proyecto));
}

// Obtiene el inventario persistente y anuncia errores en la sección visible.
async function actualizarProyectos() {
  const lista = document.querySelector("#lista-proyectos");
  try {
    const respuesta = await fetch("/api/proyectos");
    const resultado = await respuesta.json();
    if (respuesta.status === 401) {
      window.location.assign("/iniciar-sesion");
      return;
    }
    if (!respuesta.ok) throw new Error(resultado.mensaje ?? "No se pudieron consultar los proyectos.");
    mostrarProyectos(resultado.proyectos);
  } catch (error) {
    lista.replaceChildren();
    const mensaje = document.createElement("p");
    mensaje.className = "proyectos-vacio proyectos-error";
    mensaje.textContent = error.message;
    lista.append(mensaje);
  }
}

function actualizarSelectoresProyectos(proyectos) {
  for (const id of ["terminal-proyecto", "archivos-proyecto"]) {
    const selector = document.querySelector(`#${id}`);
    const seleccionado = selector.value;
    selector.replaceChildren(new Option("Selecciona un proyecto", ""));
    for (const proyecto of proyectos) {
      const opcion = new Option(proyecto.nombre, proyecto.id);
      selector.append(opcion);
    }
    if (proyectos.some((proyecto) => proyecto.id === seleccionado)) selector.value = seleccionado;
  }
}

function crearTarjetaCatalogo([nombre, categoria, descripcion]) {
  const tarjeta = document.createElement("article");
  tarjeta.className = "tarjeta-tecnologia";
  const titulo = document.createElement("strong");
  titulo.textContent = nombre;
  const detalle = document.createElement("p");
  detalle.textContent = descripcion;
  const etiqueta = document.createElement("span");
  etiqueta.className = "etiqueta-tecnologia";
  etiqueta.textContent = categoria;
  tarjeta.append(titulo, detalle, etiqueta);
  return tarjeta;
}

function mostrarCatalogosTecnologias() {
  const runtimes = document.querySelector("#catalogo-runtimes");
  const basesDatos = document.querySelector("#catalogo-bases-datos");
  if (!runtimes.childElementCount) {
    runtimes.replaceChildren(...CATALOGO_RUNTIME.map(crearTarjetaCatalogo));
    basesDatos.replaceChildren(...CATALOGO_BASES_DATOS.map(crearTarjetaCatalogo));
  }
}

function mostrarTecnologiasActivas(proyectos) {
  const lista = document.querySelector("#lista-tecnologias-activas");
  const listaBases = document.querySelector("#lista-bases-datos");
  lista.replaceChildren();
  const desplegados = proyectos.filter((proyecto) => proyecto.estado === "desplegado");
  if (!desplegados.length) {
    const vacio = document.createElement("p");
    vacio.className = "estado-tecnologias";
    vacio.textContent = "Todavía no hay aplicaciones desplegadas.";
    lista.append(vacio);
  }
  for (const proyecto of desplegados) {
    const tarjeta = document.createElement("article");
    tarjeta.className = "tecnologia-activa";
    const encabezado = document.createElement("div");
    encabezado.className = "tecnologia-activa-encabezado";
    const nombre = document.createElement("strong");
    nombre.textContent = proyecto.nombre;
    const estado = document.createElement("span");
    estado.className = "etiqueta-tecnologia";
    const etiquetaRuntime = ETIQUETAS_RUNTIME[proyecto.runtimePerfil] ?? "Aplicación";
    estado.textContent = `${etiquetaRuntime} · ${proyecto.estadoRuntime === "activo" ? "Activa" : proyecto.estadoRuntime === "detenido" ? "Detenida" : "Estado no disponible"}`;
    encabezado.append(nombre, estado);
    const detalle = document.createElement("p");
    detalle.textContent = `Puerto local: ${proyecto.puertoLocal ?? "no disponible"}`;
    tarjeta.append(encabezado, detalle);
    lista.append(tarjeta);
  }

  listaBases.replaceChildren();
  const proyectosConBase = proyectos.filter((proyecto) => proyecto.baseDatos);
  const proyectosActivosSinBase = desplegados.filter(
    (proyecto) => proyecto.estadoRuntime === "activo" && !proyecto.baseDatos,
  );
  for (const proyecto of proyectosConBase) {
    const tarjeta = document.createElement("article");
    tarjeta.className = "tecnologia-activa";
    const encabezado = document.createElement("div");
    encabezado.className = "tecnologia-activa-encabezado";
    const nombre = document.createElement("strong");
    nombre.textContent = proyecto.nombre;
    const estado = document.createElement("span");
    estado.className = "etiqueta-tecnologia";
    estado.textContent = proyecto.estado === "archivado"
      ? `${proyecto.baseDatos.motor} · Archivada`
      : `${proyecto.baseDatos.motor} · ${proyecto.estadoRuntime === "activo" ? "Activa" : proyecto.estadoRuntime === "detenido" ? "App detenida" : "App no disponible"}`;
    encabezado.append(nombre, estado);
    const detalle = document.createElement("p");
    detalle.textContent = proyecto.estado === "archivado"
      ? `El servicio ${proyecto.baseDatos.nombre} y su volumen siguen guardados, pero la aplicación asociada fue eliminada. Datos: ${proyecto.baseDatos.rutaDatos ?? "volumen Docker persistente"}.`
      : `Base ${proyecto.baseDatos.nombre} · servicio privado en puerto ${proyecto.baseDatos.puerto} · datos: ${proyecto.baseDatos.rutaDatos ?? "volumen Docker persistente"}`;
    tarjeta.append(encabezado, detalle);
    if (proyecto.estado === "archivado") {
      const botonEliminar = document.createElement("button");
      botonEliminar.type = "button";
      botonEliminar.className = "boton-accion-proyecto boton-accion-proyecto-peligro";
      botonEliminar.dataset.gestionProyecto = "eliminar-base";
      botonEliminar.dataset.proyectoId = proyecto.id;
      botonEliminar.dataset.proyectoNombre = proyecto.nombre;
      botonEliminar.dataset.nombreBaseDatos = proyecto.baseDatos.nombre;
      botonEliminar.textContent = "Eliminar base y volumen";
      tarjeta.append(botonEliminar);
    } else {
      const botonCredenciales = document.createElement("button");
      botonCredenciales.type = "button";
      botonCredenciales.className = "boton-desplegar-php";
      botonCredenciales.dataset.accionCredencialesBaseDatos = "mostrar";
      botonCredenciales.dataset.proyectoId = proyecto.id;
      botonCredenciales.dataset.proyectoNombre = proyecto.nombre;
      botonCredenciales.dataset.motorBaseDatos = proyecto.baseDatos.motor;
      botonCredenciales.dataset.nombreBaseDatos = proyecto.baseDatos.nombre;
      botonCredenciales.dataset.rutaProyecto = proyecto.rutaProyecto ?? "";
      botonCredenciales.textContent = "Mostrar conexión";
      tarjeta.append(botonCredenciales);
    }
    listaBases.append(tarjeta);
  }
  for (const proyecto of proyectosActivosSinBase) {
    const tarjeta = document.createElement("article");
    tarjeta.className = "tecnologia-activa";
    const nombre = document.createElement("strong");
    nombre.textContent = proyecto.nombre;
    const detalle = document.createElement("p");
    detalle.textContent = "No tiene un servicio de base de datos asociado.";
    const botonCrear = document.createElement("button");
    botonCrear.type = "button";
    botonCrear.className = "boton-desplegar-php";
    botonCrear.dataset.accionBaseDatos = "crear";
    botonCrear.dataset.proyectoId = proyecto.id;
    botonCrear.dataset.proyectoNombre = proyecto.nombre;
    botonCrear.textContent = "Crear base de datos";
    tarjeta.append(nombre, detalle, botonCrear);
    listaBases.append(tarjeta);
  }
  if (!proyectosConBase.length && !proyectosActivosSinBase.length) {
    const vacio = document.createElement("p");
    vacio.className = "estado-tecnologias";
    vacio.textContent = "Inicia una aplicación desplegada para crear o asociar su servicio de base de datos.";
    listaBases.append(vacio);
  }
}

async function actualizarTecnologias() {
  mostrarCatalogosTecnologias();
  document.querySelector("#mensaje-tecnologias").hidden = true;
  document.querySelector("#mensaje-tecnologias").textContent = "";
  const lista = document.querySelector("#lista-tecnologias-activas");
  const cargando = document.createElement("p");
  cargando.className = "estado-tecnologias";
  cargando.textContent = "Consultando aplicaciones...";
  lista.replaceChildren(cargando);
  document.querySelector("#lista-bases-datos").replaceChildren(cargando.cloneNode(true));
  try {
    const respuesta = await fetch("/api/proyectos");
    const resultado = await respuesta.json();
    if (respuesta.status === 401) {
      window.location.assign("/iniciar-sesion");
      return;
    }
    if (!respuesta.ok) throw new Error(resultado.mensaje ?? "No se pudieron consultar las aplicaciones.");
    mostrarTecnologiasActivas(resultado.proyectos);
  } catch (error) {
    const mensaje = document.createElement("p");
    mensaje.className = "estado-tecnologias tecnologias-error";
    mensaje.textContent = error.message;
    lista.replaceChildren(mensaje);
    document.querySelector("#lista-bases-datos").replaceChildren(mensaje.cloneNode(true));
  }
}

let emuladorTerminal;
let ajusteTerminal;
let conexionTerminal;

function establecerEstadoTerminal(mensaje, estado = "") {
  const etiqueta = document.querySelector("#terminal-estado");
  etiqueta.textContent = mensaje;
  etiqueta.dataset.estado = estado;
}

function actualizarAvatar(elemento, nombre, fotoPerfil) {
  elemento.textContent = fotoPerfil ? "" : (nombre || "?").slice(0, 1).toUpperCase();
  elemento.style.backgroundImage = fotoPerfil ? `url("${fotoPerfil}")` : "";
}

function actualizarEstadoFotoPerfil() {
  const indicador = document.querySelector("#estado-foto-perfil");
  const selector = document.querySelector(".boton-elegir-foto");
  const botonQuitar = document.querySelector("#quitar-foto-perfil");
  const fotoActual = sesionActual?.fotoPerfil;
  selector.textContent = fotoActual || (fotoPerfilModificada && fotoPerfilPendiente)
    ? "Cambiar foto"
    : "Elegir foto";
  botonQuitar.hidden = !fotoActual && !(fotoPerfilModificada && fotoPerfilPendiente);
  indicador.textContent = fotoPerfilModificada
    ? fotoPerfilPendiente
      ? "Foto seleccionada; pulsa Guardar perfil para conservarla."
      : "La foto guardada se quitará al guardar el perfil."
    : fotoActual
      ? "Foto guardada en tu cuenta."
      : "No hay una foto guardada en tu cuenta.";
}

async function prepararEmuladorTerminal() {
  if (emuladorTerminal) return;
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("/vendor/xterm.mjs"),
    import("/vendor/addon-fit.mjs"),
  ]);
  emuladorTerminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
    fontSize: 13,
    scrollback: 3000,
    theme: { background: "#080d12", foreground: "#d7e1ed" },
  });
  ajusteTerminal = new FitAddon();
  emuladorTerminal.loadAddon(ajusteTerminal);
  emuladorTerminal.open(document.querySelector("#terminal-emulador"));
  ajusteTerminal.fit();
  emuladorTerminal.onData((datos) => {
    if (conexionTerminal?.readyState === WebSocket.OPEN) {
      conexionTerminal.send(new TextEncoder().encode(datos));
    }
  });
  emuladorTerminal.onResize(({ cols, rows }) => {
    if (conexionTerminal?.readyState === WebSocket.OPEN) {
      conexionTerminal.send(JSON.stringify({ tipo: "redimensionar", columnas: cols, filas: rows }));
    }
  });
  new ResizeObserver(() => ajusteTerminal.fit()).observe(document.querySelector("#terminal-emulador"));
}

async function iniciarTerminal() {
  const id = document.querySelector("#terminal-proyecto").value;
  if (!id) {
    establecerEstadoTerminal("Selecciona un proyecto", "error");
    return;
  }
  document.querySelector("#iniciar-terminal").disabled = true;
  establecerEstadoTerminal("Conectando...");
  try {
    await prepararEmuladorTerminal();
    if (conexionTerminal) conexionTerminal.close();
    emuladorTerminal.clear();
    ajusteTerminal.fit();
    const esquema = location.protocol === "https:" ? "wss:" : "ws:";
    const direccion = new URL(`${esquema}//${location.host}/api/proyectos/${encodeURIComponent(id)}/terminal`);
    direccion.searchParams.set("columnas", String(emuladorTerminal.cols));
    direccion.searchParams.set("filas", String(emuladorTerminal.rows));
    conexionTerminal = new WebSocket(direccion);
    conexionTerminal.binaryType = "arraybuffer";
    conexionTerminal.addEventListener("open", () => {
      establecerEstadoTerminal("Conectada", "conectada");
      document.querySelector("#cerrar-terminal").disabled = false;
      emuladorTerminal.focus();
    });
    conexionTerminal.addEventListener("message", async (evento) => {
      if (typeof evento.data === "string") {
        try {
          const mensaje = JSON.parse(evento.data);
          if (mensaje.tipo === "estado") establecerEstadoTerminal(mensaje.mensaje);
          else if (mensaje.tipo === "lista") establecerEstadoTerminal("Conectada", "conectada");
          else if (mensaje.tipo === "error") {
            establecerEstadoTerminal(mensaje.mensaje, "error");
            emuladorTerminal.writeln(`\r\n${mensaje.mensaje}`);
          }
        } catch {
          emuladorTerminal.write(evento.data);
        }
        return;
      }
      const salida = evento.data instanceof ArrayBuffer
        ? evento.data
        : await evento.data.arrayBuffer();
      emuladorTerminal.write(new Uint8Array(salida));
    });
    conexionTerminal.addEventListener("close", () => {
      const etiqueta = document.querySelector("#terminal-estado");
      if (etiqueta.dataset.estado !== "error") establecerEstadoTerminal("Desconectada");
      document.querySelector("#cerrar-terminal").disabled = true;
      document.querySelector("#iniciar-terminal").disabled = false;
    });
    conexionTerminal.addEventListener("error", () => {
      establecerEstadoTerminal("No se pudo conectar; comprueba el agente del servidor.", "error");
    });
  } catch (error) {
    establecerEstadoTerminal(error.message, "error");
    document.querySelector("#iniciar-terminal").disabled = false;
  }
}

function cerrarTerminal() {
  conexionTerminal?.close(1000, "Sesión cerrada por el usuario");
  conexionTerminal = null;
  establecerEstadoTerminal("Desconectada");
  document.querySelector("#cerrar-terminal").disabled = true;
  document.querySelector("#iniciar-terminal").disabled = false;
}

let rutaDirectorioEditor = ".";
let archivoEditorAbierto = "";

function establecerMensajeEditor(mensaje, error = false) {
  const estado = document.querySelector("#mensaje-editor");
  estado.textContent = mensaje;
  estado.classList.toggle("proyecto-error", error);
}

async function solicitarArchivo(url, opciones) {
  const respuesta = await fetch(url, opciones);
  const resultado = await respuesta.json();
  if (respuesta.status === 401) {
    window.location.assign("/iniciar-sesion");
    throw new Error("La sesión ha expirado.");
  }
  if (!respuesta.ok) throw new Error(resultado.mensaje ?? "No se pudo completar la operación de archivos.");
  return resultado;
}

async function actualizarListaArchivos(ruta = document.querySelector("#editor-directorio").value.trim() || ".") {
  const id = document.querySelector("#archivos-proyecto").value;
  const lista = document.querySelector("#editor-elementos");
  if (!id) {
    const mensaje = document.createElement("p");
    mensaje.className = "proyectos-vacio";
    mensaje.textContent = "Selecciona uno de tus proyectos.";
    lista.replaceChildren(mensaje);
    return;
  }
  rutaDirectorioEditor = ruta;
  document.querySelector("#editor-directorio").value = ruta;
  try {
    const url = `/api/proyectos/${encodeURIComponent(id)}/archivos?ruta=${encodeURIComponent(ruta)}`;
    const { elementos } = await solicitarArchivo(url);
    lista.replaceChildren();
    if (!elementos.length) {
      const vacio = document.createElement("p");
      vacio.className = "proyectos-vacio";
      vacio.textContent = "Esta carpeta está vacía.";
      lista.append(vacio);
      return;
    }
    for (const elemento of elementos) {
      const boton = document.createElement("button");
      boton.type = "button";
      boton.className = "elemento-editor";
      boton.dataset.tipo = elemento.tipo;
      boton.dataset.nombre = elemento.nombre;
      boton.title = elemento.nombre;
      const icono = document.createElement("span");
      icono.className = "elemento-editor-icono";
      icono.setAttribute("aria-hidden", "true");
      icono.textContent = elemento.tipo === "directorio" ? "📁" : elemento.tipo === "archivo" ? "📄" : "⚠";
      const nombre = document.createElement("span");
      nombre.className = "elemento-editor-nombre";
      nombre.textContent = elemento.nombre;
      const detalle = document.createElement("small");
      detalle.className = "elemento-editor-detalle";
      detalle.textContent = elemento.tipo === "directorio"
        ? "Carpeta"
        : elemento.tipo === "archivo"
          ? `${new Intl.NumberFormat("es").format(elemento.bytes)} bytes`
          : "Tipo de archivo no admitido";
      boton.append(icono, nombre, detalle);
      lista.append(boton);
    }
  } catch (error) {
    const mensaje = document.createElement("p");
    mensaje.className = "proyectos-vacio proyectos-error";
    mensaje.textContent = error.message;
    lista.replaceChildren(mensaje);
  }
}

async function abrirArchivoProyecto(ruta) {
  const id = document.querySelector("#archivos-proyecto").value;
  try {
    const url = `/api/proyectos/${encodeURIComponent(id)}/archivo?ruta=${encodeURIComponent(ruta)}`;
    const archivo = await solicitarArchivo(url);
    archivoEditorAbierto = archivo.ruta;
    document.querySelector("#editor-ruta-archivo").value = archivo.ruta;
    document.querySelector("#editor-contenido").value = archivo.contenido;
    document.querySelector("#guardar-archivo").disabled = false;
    document.querySelector("#borrar-archivo").disabled = false;
    establecerMensajeEditor(`Archivo abierto: ${archivo.ruta}`);
  } catch (error) {
    establecerMensajeEditor(error.message, true);
  }
}

document.querySelector("#iniciar-terminal").addEventListener("click", iniciarTerminal);
document.querySelector("#cerrar-terminal").addEventListener("click", cerrarTerminal);
document.querySelector("#terminal-proyecto").addEventListener("change", cerrarTerminal);
document.querySelector("#archivos-proyecto").addEventListener("change", () => {
  archivoEditorAbierto = "";
  document.querySelector("#editor-ruta-archivo").value = "";
  document.querySelector("#editor-contenido").value = "";
  document.querySelector("#guardar-archivo").disabled = true;
  document.querySelector("#borrar-archivo").disabled = true;
  void actualizarListaArchivos(".");
});
document.querySelector("#actualizar-archivos").addEventListener("click", () => {
  void actualizarListaArchivos();
});
document.querySelector("#abrir-directorio").addEventListener("click", () => {
  void actualizarListaArchivos();
});
document.querySelector("#subir-carpeta-padre").addEventListener("click", () => {
  const partes = rutaDirectorioEditor.split("/").filter((parte) => parte && parte !== ".");
  partes.pop();
  void actualizarListaArchivos(partes.join("/") || ".");
});
document.querySelector("#editor-elementos").addEventListener("click", (evento) => {
  const boton = evento.target.closest("button[data-nombre]");
  if (!boton) return;
  const ruta = [rutaDirectorioEditor, boton.dataset.nombre].filter((parte) => parte && parte !== ".").join("/");
  if (boton.dataset.tipo === "directorio") void actualizarListaArchivos(ruta);
  else void abrirArchivoProyecto(ruta);
});
document.querySelector("#crear-directorio").addEventListener("click", async () => {
  const id = document.querySelector("#archivos-proyecto").value;
  const nombre = window.prompt("Nombre de la nueva carpeta");
  if (!id || !nombre?.trim()) return;
  const ruta = [rutaDirectorioEditor, nombre.trim()].filter((parte) => parte && parte !== ".").join("/");
  try {
    await solicitarArchivo(`/api/proyectos/${encodeURIComponent(id)}/directorios`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ruta }),
    });
    establecerMensajeEditor("Carpeta creada.");
    await actualizarListaArchivos(rutaDirectorioEditor);
  } catch (error) {
    establecerMensajeEditor(error.message, true);
  }
});
async function subirArchivosSeleccionados(evento, incluirRutaRelativa = false) {
  const id = document.querySelector("#archivos-proyecto").value;
  const archivos = Array.from(evento.target.files ?? []);
  let subidos = 0;
  if (!archivos.length) return;
  if (!id) {
    establecerMensajeEditor("Selecciona primero el proyecto donde quieres subir los archivos.", true);
    evento.target.value = "";
    return;
  }
  try {
    const totalBytes = archivos.reduce((total, archivo) => total + archivo.size, 0);
    if (archivos.length > 100) throw new Error("Puedes subir como máximo 100 archivos a la vez.");
    if (totalBytes > 10 * 1024 * 1024) throw new Error("El tamaño total de una subida no puede superar 10 MiB.");
    if (archivos.some((archivo) => archivo.size > 1_048_576)) {
      throw new Error("Cada archivo debe tener como máximo 1 MiB.");
    }
    for (const archivo of archivos) {
      const rutaRelativa = incluirRutaRelativa
        ? archivo.webkitRelativePath
        : archivo.name;
      if (!rutaRelativa) throw new Error(`No se pudo obtener la ruta de ${archivo.name}.`);
      const bytes = new Uint8Array(await archivo.arrayBuffer());
      let binario = "";
      for (const byte of bytes) binario += String.fromCharCode(byte);
      const ruta = [rutaDirectorioEditor, rutaRelativa].filter((parte) => parte && parte !== ".").join("/");
      await solicitarArchivo(`/api/proyectos/${encodeURIComponent(id)}/archivo`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruta, contenidoBase64: btoa(binario) }),
      });
      subidos += 1;
    }
    establecerMensajeEditor(`${subidos} archivo${subidos === 1 ? "" : "s"} subido${subidos === 1 ? "" : "s"}.`);
    await actualizarListaArchivos(rutaDirectorioEditor);
  } catch (error) {
    if (subidos > 0) await actualizarListaArchivos(rutaDirectorioEditor);
    const detalleParcial = subidos > 0
      ? ` Se alcanzaron a subir ${subidos} archivo${subidos === 1 ? "" : "s"} antes del error.`
      : "";
    establecerMensajeEditor(`${error.message}${detalleParcial}`, true);
  } finally {
    evento.target.value = "";
  }
}

document.querySelector("#subir-archivo").addEventListener("change", (evento) => {
  void subirArchivosSeleccionados(evento);
});
document.querySelector("#subir-carpeta").addEventListener("change", (evento) => {
  void subirArchivosSeleccionados(evento, true);
});
document.querySelector("#guardar-archivo").addEventListener("click", async () => {
  const id = document.querySelector("#archivos-proyecto").value;
  try {
    await solicitarArchivo(`/api/proyectos/${encodeURIComponent(id)}/archivo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ruta: archivoEditorAbierto,
        contenido: document.querySelector("#editor-contenido").value,
      }),
    });
    establecerMensajeEditor("Cambios guardados.");
  } catch (error) {
    establecerMensajeEditor(error.message, true);
  }
});
document.querySelector("#borrar-archivo").addEventListener("click", async () => {
  if (!archivoEditorAbierto || !window.confirm(`¿Borrar ${archivoEditorAbierto}?`)) return;
  const id = document.querySelector("#archivos-proyecto").value;
  try {
    await solicitarArchivo(`/api/proyectos/${encodeURIComponent(id)}/archivo`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ruta: archivoEditorAbierto }),
    });
    archivoEditorAbierto = "";
    document.querySelector("#editor-ruta-archivo").value = "";
    document.querySelector("#editor-contenido").value = "";
    document.querySelector("#guardar-archivo").disabled = true;
    document.querySelector("#borrar-archivo").disabled = true;
    establecerMensajeEditor("Archivo borrado.");
    await actualizarListaArchivos(rutaDirectorioEditor);
  } catch (error) {
    establecerMensajeEditor(error.message, true);
  }
});
document.querySelector("#actualizar-tecnologias").addEventListener("click", actualizarTecnologias);

document.querySelector("#lista-proyectos").addEventListener("click", async (evento) => {
  const boton = evento.target.closest("button[data-comando-tunel]");
  if (!boton) return;
  try {
    await navigator.clipboard.writeText(boton.dataset.comandoTunel);
    boton.textContent = "Comando copiado";
  } catch (error) {
    const mensaje = document.querySelector("#proyecto-mensaje");
    mensaje.textContent = `No se pudo copiar el comando: ${error.message}. Cópialo manualmente: ${boton.dataset.comandoTunel}`;
    mensaje.classList.add("proyecto-error");
  }
});

// Abre los archivos Compose como texto plano, sin interpretarlos ni ejecutarlos.
document.querySelector("#lista-proyectos").addEventListener("click", async (evento) => {
  const boton = evento.target.closest("button[data-archivo-compose]");
  if (!boton) return;
  const dialogo = document.querySelector("#dialogo-compose");
  const contenido = document.querySelector("#dialogo-compose-texto");
  const error = document.querySelector("#dialogo-compose-error");
  document.querySelector("#dialogo-compose-titulo").textContent =
    `${boton.dataset.archivoCompose} · revisión`;
  contenido.textContent = "Cargando archivo...";
  error.textContent = "";
  dialogo.showModal();
  try {
    const respuesta = await fetch(
      `/api/proyectos/${encodeURIComponent(boton.dataset.proyectoId)}/compose/${encodeURIComponent(boton.dataset.archivoCompose)}`,
    );
    const resultado = await respuesta.json();
    if (respuesta.status === 401) {
      window.location.assign("/iniciar-sesion");
      return;
    }
    if (!respuesta.ok) throw new Error(resultado.mensaje ?? "No se pudo leer el archivo Compose.");
    contenido.textContent = resultado.contenido;
  } catch (fallo) {
    contenido.textContent = "";
    error.textContent = fallo.message;
  }
});

// Abre el diálogo de despliegue con una confirmación escrita exacta.
document.querySelector("#lista-proyectos").addEventListener("click", (evento) => {
  const boton = evento.target.closest("button[data-proyecto-id]");
  if (!boton || !boton.classList.contains("boton-desplegar-php")) return;
  if (boton.dataset.accionBaseDatos || boton.dataset.accionCredencialesBaseDatos) return;
  proyectoPhpPendiente = {
    id: boton.dataset.proyectoId,
    nombre: boton.dataset.proyectoNombre,
  };
  document.querySelector("#dialogo-despliegue-descripcion").textContent =
    `El proyecto ${proyectoPhpPendiente.nombre} se preparará con un perfil administrado dentro de una red privada. No se ejecutarán su Dockerfile ni sus archivos Compose.`;
  document.querySelector("#error-despliegue").textContent = "";
  document.querySelector("#confirmar-nombre-proyecto").value = "";
  actualizarAyudaPerfil();
  actualizarBotonDespliegue();
  document.querySelector("#dialogo-despliegue").showModal();
  document.querySelector("#confirmar-nombre-proyecto").focus();
});

// Abre una confirmación escrita para cambiar el estado del runtime.
document.querySelector("#lista-proyectos").addEventListener("click", (evento) => {
  const boton = evento.target.closest("button[data-accion-php]");
  if (!boton) return;
  proyectoPhpPendiente = {
    id: boton.dataset.proyectoId,
    nombre: boton.dataset.proyectoNombre,
    accion: boton.dataset.accionPhp,
  };
  document.querySelector("#dialogo-accion-php-titulo").textContent =
    `${proyectoPhpPendiente.accion[0].toUpperCase()}${proyectoPhpPendiente.accion.slice(1)} proyecto`;
  document.querySelector("#dialogo-accion-php-descripcion").textContent =
    `La acción "${proyectoPhpPendiente.accion}" afecta únicamente al runtime registrado para ${proyectoPhpPendiente.nombre}.`;
  document.querySelector("#error-accion-php").textContent = "";
  document.querySelector("#confirmar-nombre-accion-php").value = "";
  actualizarBotonAccionPhp();
  document.querySelector("#dialogo-accion-php").showModal();
  document.querySelector("#confirmar-nombre-accion-php").focus();
});

function actualizarBotonAccionPhp() {
  const entrada = document.querySelector("#confirmar-nombre-accion-php");
  document.querySelector("#confirmar-accion-php").disabled =
    !proyectoPhpPendiente?.accion || entrada.value !== proyectoPhpPendiente.nombre;
}

document.querySelector("#confirmar-nombre-accion-php").addEventListener("input", actualizarBotonAccionPhp);
document.querySelector("#cancelar-accion-php").addEventListener("click", () => {
  document.querySelector("#dialogo-accion-php").close();
  proyectoPhpPendiente = null;
});

// Envía únicamente la acción allowlisted y recarga el estado real del runtime.
document.querySelector("#formulario-accion-php").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (!proyectoPhpPendiente?.accion || document.querySelector("#confirmar-accion-php").disabled) return;
  const boton = document.querySelector("#confirmar-accion-php");
  const mensaje = document.querySelector("#proyecto-mensaje");
  const error = document.querySelector("#error-accion-php");
  const { id, nombre, accion } = proyectoPhpPendiente;
  boton.disabled = true;
  boton.textContent = "Procesando...";
  error.textContent = "";
  try {
    const respuesta = await fetch(`/api/proyectos/${encodeURIComponent(id)}/accion-runtime`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accion,
        nombreConfirmado: document.querySelector("#confirmar-nombre-accion-php").value,
      }),
    });
    const resultado = await respuesta.json();
    if (respuesta.status === 401) {
      window.location.assign("/iniciar-sesion");
      return;
    }
    if (!respuesta.ok) throw new Error(resultado.mensaje ?? "No se pudo controlar el runtime.");
    document.querySelector("#dialogo-accion-php").close();
    proyectoPhpPendiente = null;
    mensaje.textContent = resultado.mensaje;
    mensaje.classList.remove("proyecto-error");
    await actualizarProyectos();
  } catch (fallo) {
    error.textContent = fallo.message;
  } finally {
    boton.textContent = "Confirmar acción";
    actualizarBotonAccionPhp();
  }
});

const selectoresGestionProyecto = ["#lista-proyectos", "#lista-bases-datos"];
for (const selector of selectoresGestionProyecto) {
  document.querySelector(selector).addEventListener("click", (evento) => {
    const boton = evento.target.closest("button[data-gestion-proyecto]");
    if (!boton) return;
    gestionProyectoPendiente = {
      id: boton.dataset.proyectoId,
      nombre: boton.dataset.proyectoNombre,
      accion: boton.dataset.gestionProyecto,
      nombreBaseDatos: boton.dataset.nombreBaseDatos,
    };
    const descripciones = {
      actualizar: {
        titulo: "Aplicar cambios a la aplicación",
        texto: "Se reconstruirá el runtime usando los archivos actuales. En perfiles distintos de PHP, un error de compilación puede dejar retirada la versión anterior hasta que corrijas los archivos y vuelvas a desplegar. La aplicación puede quedar temporalmente fuera de servicio.",
        boton: "Actualizar aplicación",
      },
      "eliminar-app": {
        titulo: "Eliminar aplicación",
        texto: "Se eliminarán el código y el runtime. Si existe una base de datos, se conservará archivada con todos sus datos hasta que la elimines por separado.",
        boton: "Eliminar aplicación",
      },
      "eliminar-base": {
        titulo: "Eliminar base de datos",
        texto: "Se eliminarán permanentemente el servicio de base de datos y su volumen persistente. Esta acción no se puede deshacer.",
        boton: "Eliminar base y volumen",
      },
    };
    const descripcion = descripciones[gestionProyectoPendiente.accion];
    if (!descripcion) {
      gestionProyectoPendiente = null;
      return;
    }
    document.querySelector("#dialogo-gestion-proyecto-titulo").textContent = descripcion.titulo;
    document.querySelector("#dialogo-gestion-proyecto-descripcion").textContent = descripcion.texto;
    document.querySelector("#confirmar-gestion-proyecto").textContent = descripcion.boton;
    document.querySelector("#error-gestion-proyecto").textContent = "";
    document.querySelector("#confirmar-nombre-gestion-proyecto").value = "";
    actualizarBotonGestionProyecto();
    document.querySelector("#dialogo-gestion-proyecto").showModal();
    document.querySelector("#confirmar-nombre-gestion-proyecto").focus();
  });
}

function actualizarBotonGestionProyecto() {
  const entrada = document.querySelector("#confirmar-nombre-gestion-proyecto");
  document.querySelector("#confirmar-gestion-proyecto").disabled =
    !gestionProyectoPendiente || entrada.value !== gestionProyectoPendiente.nombre;
}

document.querySelector("#confirmar-nombre-gestion-proyecto").addEventListener("input", actualizarBotonGestionProyecto);
document.querySelector("#cancelar-gestion-proyecto").addEventListener("click", () => {
  if (operacionGestionProyectoActiva) return;
  document.querySelector("#dialogo-gestion-proyecto").close();
  gestionProyectoPendiente = null;
});
document.querySelector("#dialogo-gestion-proyecto").addEventListener("cancel", (evento) => {
  if (operacionGestionProyectoActiva) evento.preventDefault();
});

let operacionGestionProyectoActiva = false;
document.querySelector("#formulario-gestion-proyecto").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (!gestionProyectoPendiente || document.querySelector("#confirmar-gestion-proyecto").disabled) return;
  const boton = document.querySelector("#confirmar-gestion-proyecto");
  const error = document.querySelector("#error-gestion-proyecto");
  const { id, nombre, accion } = gestionProyectoPendiente;
  const configuracion = {
    actualizar: {
      metodo: "POST",
      ruta: `/api/proyectos/${encodeURIComponent(id)}/actualizar`,
    },
    "eliminar-app": {
      metodo: "DELETE",
      ruta: `/api/proyectos/${encodeURIComponent(id)}`,
    },
    "eliminar-base": {
      metodo: "DELETE",
      ruta: `/api/proyectos/${encodeURIComponent(id)}/base-datos`,
    },
  }[accion];
  if (!configuracion) return;
  operacionGestionProyectoActiva = true;
  document.querySelector("#cancelar-gestion-proyecto").disabled = true;
  boton.disabled = true;
  boton.textContent = "Procesando...";
  error.textContent = "";
  try {
    const respuesta = await fetch(configuracion.ruta, {
      method: configuracion.metodo,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nombreConfirmado: nombre,
        ...(accion === "eliminar-base" ? { nombreBaseDatos: gestionProyectoPendiente.nombreBaseDatos } : {}),
      }),
    });
    const resultado = await respuesta.json();
    if (respuesta.status === 401) {
      window.location.assign("/iniciar-sesion");
      return;
    }
    if (!respuesta.ok) throw new Error(resultado.mensaje ?? "No se pudo completar la acción del proyecto.");
    document.querySelector("#dialogo-gestion-proyecto").close();
    gestionProyectoPendiente = null;
    const mensaje = document.querySelector("#proyecto-mensaje");
    mensaje.textContent = resultado.mensaje;
    mensaje.classList.remove("proyecto-error");
    const mensajeTecnologias = document.querySelector("#mensaje-tecnologias");
    mensajeTecnologias.textContent = resultado.mensaje;
    mensajeTecnologias.hidden = false;
    await actualizarProyectos();
  } catch (fallo) {
    error.textContent = fallo.message;
  } finally {
    operacionGestionProyectoActiva = false;
    document.querySelector("#cancelar-gestion-proyecto").disabled = false;
    boton.textContent = accion === "actualizar"
      ? "Actualizar aplicación"
      : accion === "eliminar-base"
        ? "Eliminar base y volumen"
        : "Eliminar aplicación";
    if (gestionProyectoPendiente) actualizarBotonGestionProyecto();
  }
});

// Abre el alta de un motor fijo asociado solo a la red privada del proyecto.
for (const selector of selectoresGestionProyecto) {
  document.querySelector(selector).addEventListener("click", (evento) => {
    const boton = evento.target.closest("button[data-accion-base-datos]");
    if (!boton) return;
    proyectoBaseDatosPendiente = {
      id: boton.dataset.proyectoId,
      nombre: boton.dataset.proyectoNombre,
      rutaProyecto: boton.dataset.rutaProyecto,
    };
    const descripcionBaseDatos = document.querySelector("#dialogo-base-datos-descripcion");
    descripcionBaseDatos.textContent = `Se creará una base de datos privada para ${proyectoBaseDatosPendiente.nombre}.`;
    if (proyectoBaseDatosPendiente.rutaProyecto) {
      descripcionBaseDatos.textContent += ` El código editable del proyecto está en ${proyectoBaseDatosPendiente.rutaProyecto}.`;
    }
    document.querySelector("#error-base-datos").textContent = "";
    document.querySelector("#resultado-base-datos").hidden = true;
    document.querySelector("#resultado-base-datos").textContent = "";
    document.querySelector("#confirmar-nombre-base-datos").value = "";
    const entradaNombreBase = document.querySelector("#nombre-base-datos");
    entradaNombreBase.value = "swatt";
    entradaNombreBase.disabled = false;
    document.querySelector("#motor-base-datos").value = "postgresql";
    actualizarNombreBaseDatos();
    actualizarBotonBaseDatos();
    document.querySelector("#dialogo-base-datos").showModal();
    document.querySelector("#confirmar-nombre-base-datos").focus();
  });
}

function actualizarBotonBaseDatos() {
  const entrada = document.querySelector("#confirmar-nombre-base-datos");
  const nombreBase = document.querySelector("#nombre-base-datos");
  const boton = document.querySelector("#confirmar-base-datos");
  boton.disabled = !proyectoBaseDatosPendiente
    || entrada.value !== proyectoBaseDatosPendiente.nombre
    || (document.querySelector("#motor-base-datos").value !== "redis"
      && !/^[a-z][a-z0-9_]{0,62}$/.test(nombreBase.value));
}

document.querySelector("#confirmar-nombre-base-datos").addEventListener("input", actualizarBotonBaseDatos);
document.querySelector("#nombre-base-datos").addEventListener("input", actualizarBotonBaseDatos);
document.querySelector("#motor-base-datos").addEventListener("change", actualizarNombreBaseDatos);
function actualizarNombreBaseDatos() {
  const redis = document.querySelector("#motor-base-datos").value === "redis";
  const entrada = document.querySelector("#nombre-base-datos");
  entrada.disabled = redis;
  entrada.value = redis ? "0" : entrada.value === "0" ? "swatt" : entrada.value;
  actualizarBotonBaseDatos();
}
document.querySelector("#cancelar-base-datos").addEventListener("click", () => {
  if (operacionBaseDatosActiva) return;
  document.querySelector("#dialogo-base-datos").close();
  proyectoBaseDatosPendiente = null;
});
document.querySelector("#dialogo-base-datos").addEventListener("cancel", (evento) => {
  if (operacionBaseDatosActiva) evento.preventDefault();
});

// Muestra la credencial solo en memoria del navegador; nunca la persiste ni registra.
document.querySelector("#formulario-base-datos").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (!proyectoBaseDatosPendiente || document.querySelector("#confirmar-base-datos").disabled) return;
  const boton = document.querySelector("#confirmar-base-datos");
  const error = document.querySelector("#error-base-datos");
  const salida = document.querySelector("#resultado-base-datos");
  const { id, nombre } = proyectoBaseDatosPendiente;
  operacionBaseDatosActiva = true;
  document.querySelector("#cancelar-base-datos").disabled = true;
  boton.disabled = true;
  boton.textContent = "Creando...";
  error.textContent = "";
  salida.hidden = true;
  try {
    const respuesta = await fetch(`/api/proyectos/${encodeURIComponent(id)}/base-datos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        motor: document.querySelector("#motor-base-datos").value,
        nombreBaseDatos: document.querySelector("#nombre-base-datos").value,
        nombreConfirmado: document.querySelector("#confirmar-nombre-base-datos").value,
      }),
    });
    const resultado = await respuesta.json();
    if (respuesta.status === 401) {
      window.location.assign("/iniciar-sesion");
      return;
    }
    if (!respuesta.ok) throw new Error(resultado.mensaje ?? "No se pudo crear la base de datos.");
    salida.textContent = formatearCredencialesBaseDatos(resultado);
    salida.hidden = false;
    document.querySelector("#proyecto-mensaje").textContent =
      `${resultado.motor} quedó activa; copia su credencial antes de cerrar.`;
    const mensajeTecnologias = document.querySelector("#mensaje-tecnologias");
    mensajeTecnologias.textContent = `${resultado.motor} quedó activa; copia su credencial antes de cerrar.`;
    mensajeTecnologias.hidden = false;
    await actualizarProyectos();
  } catch (fallo) {
    error.textContent = fallo.message;
  } finally {
    operacionBaseDatosActiva = false;
    document.querySelector("#cancelar-base-datos").disabled = false;
    boton.textContent = "Crear servicio";
    if (salida.hidden) actualizarBotonBaseDatos();
  }
});

function formatearCredencialesBaseDatos(resultado) {
  const uri = {
    postgresql: `postgresql://${resultado.usuario}:${resultado.contrasena}@${resultado.host}:${resultado.puerto}/${resultado.nombre}`,
    mariadb: `mysql://${resultado.usuario}:${resultado.contrasena}@${resultado.host}:${resultado.puerto}/${resultado.nombre}`,
    mongodb: `mongodb://${resultado.usuario}:${resultado.contrasena}@${resultado.host}:${resultado.puerto}/${resultado.nombre}?authSource=${resultado.nombre}`,
    redis: `redis://${resultado.usuario}:${resultado.contrasena}@${resultado.host}:${resultado.puerto}/0`,
  }[resultado.motor];
  return [
    `Motor: ${resultado.motor}`,
    `Host interno: ${resultado.host}`,
    `Puerto interno: ${resultado.puerto}`,
    `Base de datos: ${resultado.nombre}`,
    `Usuario: ${resultado.usuario}`,
    `Contraseña: ${resultado.contrasena}`,
    `Código editable: ${proyectoBaseDatosPendiente?.rutaProyecto || "consulta la ruta en Archivos"}`,
    `Datos de la base: ${resultado.rutaDatos || "volumen Docker privado"}`,
    `URL de conexión: ${uri}`,
    "",
    "No publiques estos datos. La URL usa el DNS privado del proyecto y no funcionará desde tu PC.",
  ].join("\n");
}

for (const selector of selectoresGestionProyecto) {
  document.querySelector(selector).addEventListener("click", (evento) => {
    const boton = evento.target.closest("button[data-accion-credenciales-base-datos]");
    if (!boton) return;
    proyectoBaseDatosPendiente = {
      id: boton.dataset.proyectoId,
      nombre: boton.dataset.proyectoNombre,
      motor: boton.dataset.motorBaseDatos,
      nombreBaseDatos: boton.dataset.nombreBaseDatos,
      rutaProyecto: boton.dataset.rutaProyecto,
    };
    document.querySelector("#dialogo-credenciales-db-descripcion").textContent =
      `Confirma ${proyectoBaseDatosPendiente.nombre} para revelar la credencial almacenada de ${proyectoBaseDatosPendiente.motor}.`;
    document.querySelector("#error-credenciales-db").textContent = "";
    document.querySelector("#resultado-credenciales-db").hidden = true;
    document.querySelector("#resultado-credenciales-db").textContent = "";
    document.querySelector("#confirmar-nombre-credenciales-db").value = "";
    actualizarBotonCredencialesBaseDatos();
    document.querySelector("#dialogo-credenciales-db").showModal();
    document.querySelector("#confirmar-nombre-credenciales-db").focus();
  });
}

function actualizarBotonCredencialesBaseDatos() {
  const entrada = document.querySelector("#confirmar-nombre-credenciales-db");
  document.querySelector("#confirmar-credenciales-db").disabled =
    !proyectoBaseDatosPendiente?.motor || entrada.value !== proyectoBaseDatosPendiente.nombre;
}

document.querySelector("#confirmar-nombre-credenciales-db").addEventListener("input", actualizarBotonCredencialesBaseDatos);
document.querySelector("#cancelar-credenciales-db").addEventListener("click", () => {
  if (operacionBaseDatosActiva) return;
  document.querySelector("#dialogo-credenciales-db").close();
  proyectoBaseDatosPendiente = null;
});
document.querySelector("#dialogo-credenciales-db").addEventListener("cancel", (evento) => {
  if (operacionBaseDatosActiva) evento.preventDefault();
});

document.querySelector("#formulario-credenciales-db").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (!proyectoBaseDatosPendiente?.motor || document.querySelector("#confirmar-credenciales-db").disabled) return;
  const boton = document.querySelector("#confirmar-credenciales-db");
  const salida = document.querySelector("#resultado-credenciales-db");
  const error = document.querySelector("#error-credenciales-db");
  const { id, nombre, motor, nombreBaseDatos } = proyectoBaseDatosPendiente;
  operacionBaseDatosActiva = true;
  document.querySelector("#cancelar-credenciales-db").disabled = true;
  boton.disabled = true;
  boton.textContent = "Consultando...";
  error.textContent = "";
  try {
    const respuesta = await fetch(`/api/proyectos/${encodeURIComponent(id)}/base-datos/credenciales`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        motor,
        nombreBaseDatos,
        nombreConfirmado: document.querySelector("#confirmar-nombre-credenciales-db").value,
      }),
    });
    const resultado = await respuesta.json();
    if (respuesta.status === 401) {
      window.location.assign("/iniciar-sesion");
      return;
    }
    if (!respuesta.ok) throw new Error(resultado.mensaje ?? "No se pudieron consultar las credenciales.");
    salida.textContent = formatearCredencialesBaseDatos(resultado);
    salida.hidden = false;
  } catch (fallo) {
    error.textContent = fallo.message;
  } finally {
    operacionBaseDatosActiva = false;
    document.querySelector("#cancelar-credenciales-db").disabled = false;
    boton.textContent = "Mostrar credenciales";
    if (salida.hidden) actualizarBotonCredencialesBaseDatos();
  }
});

// Evita solicitar el despliegue hasta que se escriba el nombre exacto.
function actualizarBotonDespliegue() {
  const entrada = document.querySelector("#confirmar-nombre-proyecto");
  document.querySelector("#confirmar-despliegue").disabled =
    !proyectoPhpPendiente || entrada.value !== proyectoPhpPendiente.nombre;
}

function actualizarAyudaPerfil() {
  const perfil = document.querySelector("#perfil-runtime").value;
  const ayuda = document.querySelector("#ayuda-perfil-runtime");
  const mensajes = {
    html: "Para una web estática elige este perfil. Debe existir index.html; si solo hay archivos PHP, selecciona PHP.",
    php: "Para una aplicación PHP elige este perfil. Debe existir un único index.php en la raíz o dentro de una subcarpeta.",
  };
  ayuda.textContent = mensajes[perfil]
    ?? "Elige el perfil que coincida con el lenguaje y los archivos de inicio del proyecto.";
}

document.querySelector("#perfil-runtime").addEventListener("change", actualizarAyudaPerfil);
actualizarAyudaPerfil();
document.querySelector("#confirmar-nombre-proyecto").addEventListener("input", actualizarBotonDespliegue);
document.querySelector("#cancelar-despliegue").addEventListener("click", () => {
  document.querySelector("#dialogo-despliegue").close();
  proyectoPhpPendiente = null;
});

// Solicita al agente un perfil fijo y mantiene el servicio en localhost.
document.querySelector("#formulario-despliegue").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (!proyectoPhpPendiente || document.querySelector("#confirmar-despliegue").disabled) return;
  const boton = document.querySelector("#confirmar-despliegue");
  const mensaje = document.querySelector("#proyecto-mensaje");
  const error = document.querySelector("#error-despliegue");
  const perfil = document.querySelector("#perfil-runtime").value;
  boton.disabled = true;
  boton.textContent = "Preparando...";
  error.textContent = "";
  try {
    const respuesta = await fetch(`/api/proyectos/${encodeURIComponent(proyectoPhpPendiente.id)}/desplegar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        perfil,
        nombreConfirmado: document.querySelector("#confirmar-nombre-proyecto").value,
      }),
    });
    const resultado = await respuesta.json();
    if (respuesta.status === 401) {
      window.location.assign("/iniciar-sesion");
      return;
    }
    if (!respuesta.ok) throw new Error(resultado.mensaje ?? "No se pudo desplegar el proyecto.");
    document.querySelector("#dialogo-despliegue").close();
    proyectoPhpPendiente = null;
    mensaje.textContent =
      `${resultado.perfil} está activo en localhost:${resultado.puerto}. El servicio aún no está publicado en Tailscale.`;
    mensaje.classList.remove("proyecto-error");
    await actualizarProyectos();
  } catch (fallo) {
    error.textContent = fallo.message;
  } finally {
    boton.textContent = "Desplegar aplicación";
    actualizarBotonDespliegue();
  }
});

document.querySelector("#cerrar-dialogo-compose").addEventListener("click", () => {
  document.querySelector("#dialogo-compose").close();
});

// Añade el repositorio al área de revisión, sin construir ni ejecutar su código.
document.querySelector("#formulario-proyecto").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const formulario = evento.currentTarget;
  const boton = document.querySelector("#boton-importar-proyecto");
  const mensaje = document.querySelector("#proyecto-mensaje");
  const datos = new FormData(formulario);
  boton.disabled = true;
  boton.textContent = "Importando...";
  mensaje.textContent = "";
  mensaje.classList.remove("proyecto-error");
  try {
    const respuesta = await fetch("/api/proyectos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nombre: datos.get("nombre"),
        repositorio: datos.get("repositorio"),
        rama: datos.get("rama"),
      }),
    });
    const resultado = await respuesta.json();
    if (respuesta.status === 401) {
      window.location.assign("/iniciar-sesion");
      return;
    }
    if (!respuesta.ok) throw new Error(resultado.mensaje ?? "No se pudo importar el repositorio.");
    formulario.reset();
    document.querySelector("#proyecto-rama").value = "main";
    mensaje.textContent = "Repositorio importado. No se ha desplegado ni ejecutado ningún archivo.";
    await actualizarProyectos();
  } catch (error) {
    mensaje.textContent = error.message;
    mensaje.classList.add("proyecto-error");
  } finally {
    boton.disabled = false;
    boton.textContent = "Importar para revisar";
  }
});

// Lleva las acciones rápidas del resumen a la sección de proyectos.
document.querySelector("#ver-proyectos").addEventListener("click", () => {
  document.querySelector('[data-seccion="proyectos"]').click();
});
document.querySelector("#anadir-proyecto-resumen").addEventListener("click", () => {
  document.querySelector('[data-seccion="proyectos"]').click();
});

function obtenerAvisosHost() {
  const avisos = [];
  if (!ultimoEstadoHost) return ["No hay una lectura reciente del agente del host."];
  if (!estadoHostConectado) {
    return ["El agente está desconectado; las últimas métricas recibidas pueden estar desactualizadas."];
  }

  const seguridad = ultimoEstadoHost.seguridad ?? {};
  const disco = ultimoEstadoHost.disco ?? {};
  const mantenimiento = ultimoEstadoHost.mantenimiento ?? {};
  const docker = ultimoEstadoHost.docker ?? {};
  if (seguridad.ufw === "inactivo") avisos.push("UFW informa que el firewall está inactivo.");
  else if (seguridad.ufw == null) avisos.push("No se pudo consultar el estado de UFW.");
  if (seguridad.fail2ban === "inactivo") avisos.push("Fail2ban informa que el servicio está inactivo.");
  else if (seguridad.fail2ban == null) avisos.push("No se pudo consultar el estado de Fail2ban.");
  if (mantenimiento.reinicioNecesario === true) avisos.push("Debian indica que se requiere reiniciar el sistema.");
  if (disco.disponible && disco.porcentaje >= 90) {
    avisos.push(`El almacenamiento raíz está al ${disco.porcentaje}% de uso.`);
  }
  if (docker.disponible === false) avisos.push("Docker no está disponible para el agente.");
  if (avisos.length === 0) avisos.push("No se detectaron avisos en las comprobaciones disponibles.");
  return avisos;
}

document.querySelector("#boton-notificaciones").addEventListener("click", () => {
  const lista = document.querySelector("#lista-notificaciones");
  lista.replaceChildren();
  for (const aviso of obtenerAvisosHost()) {
    const elemento = document.createElement("p");
    elemento.className = "notificacion-elemento";
    elemento.textContent = aviso;
    lista.append(elemento);
  }
  document.querySelector("#dialogo-notificaciones").showModal();
});
document.querySelector("#cerrar-notificaciones").addEventListener("click", () => {
  document.querySelector("#dialogo-notificaciones").close();
});

// Permite ocultar el aviso informativo sin afectar el resto del panel.
document.querySelector("#cerrar-aviso").addEventListener("click", (evento) => {
  evento.currentTarget.closest(".aviso-demo").remove();
});

// Abre y cierra el menú lateral en pantallas pequeñas.
document.querySelector("#boton-menu").addEventListener("click", () => {
  barraLateral.classList.toggle("abierta");
});

// Muestra la hora de la última actualización visual del panel.
function actualizarHora() {
  document.querySelector("#ultima-actualizacion").textContent = new Intl.DateTimeFormat("es", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

// Presenta un número con una cantidad estable de decimales para las tarjetas.
function formatearNumero(numero, decimales = 1) {
  return Number(numero).toLocaleString("es", {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  });
}

// Construye filas desde texto mediante textContent para no interpretar metadatos
// de contenedores como HTML ejecutable.
function mostrarContenedores(docker) {
  ultimoDocker = docker;
  const lista = document.querySelector("#lista-contenedores");
  const resumen = document.querySelector("#docker-resumen");
  lista.replaceChildren();

  if (!docker.disponible) {
    resumen.textContent = "No se pudo consultar Docker en el host.";
    const mensaje = document.createElement("p");
    mensaje.className = "docker-cargando";
    mensaje.textContent = docker.error ?? "Docker no está disponible.";
    lista.append(mensaje);
    return;
  }

  const contenedores = docker.contenedores ?? [];
  resumen.textContent = `${docker.contenedoresActivos ?? 0} activos · ${docker.contenedoresTotal ?? contenedores.length} total · Docker ${docker.version}`;
  const filtro = document.querySelector("#buscar-contenedor").value.trim().toLocaleLowerCase("es");
  const resultados = contenedores.filter((contenedor) => [
    contenedor.nombre,
    contenedor.imagen,
    contenedor.id,
    contenedor.estado,
  ].some((valor) => valor.toLocaleLowerCase("es").includes(filtro)));

  if (resultados.length === 0) {
    const vacio = document.createElement("div");
    vacio.className = "docker-vacio";
    vacio.textContent = contenedores.length === 0
      ? "No hay contenedores Docker para mostrar."
      : "No hay contenedores que coincidan con la búsqueda.";
    lista.append(vacio);
    return;
  }

  const tabla = document.createElement("table");
  tabla.innerHTML = "<thead><tr><th>Nombre</th><th>Imagen</th><th>Estado</th><th>Puertos</th><th>Acciones</th></tr></thead>";
  const cuerpo = document.createElement("tbody");
  for (const contenedor of resultados) {
    const fila = document.createElement("tr");
    fila.dataset.contenedorId = contenedor.id;
    const nombre = document.createElement("td");
    const nombrePrincipal = document.createElement("strong");
    nombrePrincipal.textContent = contenedor.nombre || "Sin nombre";
    const identificador = document.createElement("small");
    identificador.textContent = contenedor.id;
    nombre.append(nombrePrincipal, identificador);

    const imagen = document.createElement("td");
    imagen.textContent = contenedor.imagen || "No disponible";
    const estado = document.createElement("td");
    const distintivo = document.createElement("span");
    distintivo.className = "distintivo-contenedor";
    distintivo.textContent = contenedor.estado || "Activo";
    estado.append(distintivo);
    const puertos = document.createElement("td");
    puertos.textContent = contenedor.puertos || "Sin puertos publicados";

    const acciones = document.createElement("td");
    acciones.className = "acciones-contenedor";
    if (!contenedor.administrable) {
      const protegido = document.createElement("span");
      protegido.className = "contenedor-protegido";
      protegido.textContent = "Protegido";
      acciones.append(protegido);
    } else {
      const posibles = contenedor.ejecutando
        ? [["reiniciar", "Reiniciar"], ["detener", "Detener"]]
        : [["iniciar", "Iniciar"]];
      for (const [accion, etiqueta] of posibles) {
        const boton = document.createElement("button");
        boton.type = "button";
        boton.className = `boton-accion-contenedor accion-${accion}`;
        boton.dataset.accion = accion;
        boton.textContent = etiqueta;
        boton.setAttribute("aria-label", `${etiqueta} ${contenedor.nombre}`);
        acciones.append(boton);
      }
    }

    fila.append(nombre, imagen, estado, puertos, acciones);
    cuerpo.append(fila);
  }
  tabla.append(cuerpo);
  lista.append(tabla);

  if (docker.listaLimitada) {
    const aviso = document.createElement("p");
    aviso.className = "docker-nota";
    aviso.textContent = "Se muestran los primeros 100 contenedores.";
    lista.append(aviso);
  }
}

// Solicita confirmación escrita del nombre exacto antes de contactar al backend.
document.querySelector("#lista-contenedores").addEventListener("click", (evento) => {
  const boton = evento.target.closest("button[data-accion]");
  if (!boton) return;
  const fila = boton.closest("tr");
  const contenedor = ultimoDocker?.contenedores.find((dato) => dato.id === fila?.dataset.contenedorId);
  if (!contenedor || !contenedor.administrable) return;

  accionDockerPendiente = { ...contenedor, accion: boton.dataset.accion };
  const dialogo = document.querySelector("#dialogo-docker");
  const nombre = document.querySelector("#confirmar-nombre");
  document.querySelector("#dialogo-docker-titulo").textContent =
    `${boton.dataset.accion[0].toUpperCase()}${boton.dataset.accion.slice(1)} contenedor`;
  document.querySelector("#dialogo-docker-descripcion").textContent =
    `Esto ejecutará "${boton.dataset.accion}" sobre ${contenedor.nombre}.`;
  document.querySelector("#error-confirmacion").textContent = "";
  nombre.value = "";
  actualizarBotonConfirmar();
  dialogo.showModal();
  nombre.focus();
});

// Solo habilita la operación cuando la confirmación escrita coincide exactamente.
function actualizarBotonConfirmar() {
  const entrada = document.querySelector("#confirmar-nombre");
  const boton = document.querySelector("#confirmar-accion");
  boton.disabled = !accionDockerPendiente || entrada.value !== accionDockerPendiente.nombre;
}

document.querySelector("#confirmar-nombre").addEventListener("input", actualizarBotonConfirmar);
document.querySelector("#cancelar-accion").addEventListener("click", () => {
  document.querySelector("#dialogo-docker").close();
  accionDockerPendiente = null;
});

// Envía una operación limitada: acción, ID y nombre de confirmación exacto.
document.querySelector("#formulario-docker").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (!accionDockerPendiente || document.querySelector("#confirmar-accion").disabled) return;

  const boton = document.querySelector("#confirmar-accion");
  const error = document.querySelector("#error-confirmacion");
  boton.disabled = true;
  boton.textContent = "Procesando...";
  error.textContent = "";
  try {
    const respuesta = await fetch(`/api/docker/contenedores/${encodeURIComponent(accionDockerPendiente.id)}/accion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accion: accionDockerPendiente.accion,
        nombreConfirmado: document.querySelector("#confirmar-nombre").value,
      }),
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.mensaje ?? "La acción fue rechazada.");
    document.querySelector("#dialogo-docker").close();
    avisoTitulo.textContent = "Acción Docker completada";
    avisoMensaje.textContent = resultado.mensaje;
    accionDockerPendiente = null;
    window.setTimeout(actualizarEstadoDeFormaSegura, 1500);
  } catch (fallo) {
    error.textContent = fallo.message;
  } finally {
    boton.textContent = "Confirmar";
    actualizarBotonConfirmar();
  }
});

function crearDatoAdministracion(titulo, valor, detalle = "") {
  const tarjeta = document.createElement("article");
  tarjeta.className = "dato-administracion";
  const encabezado = document.createElement("span");
  encabezado.className = "dato-administracion-titulo";
  encabezado.textContent = titulo;
  const valorElemento = document.createElement("strong");
  valorElemento.textContent = valor == null || valor === "" ? "No disponible" : String(valor);
  tarjeta.append(encabezado, valorElemento);
  if (detalle) {
    const detalleElemento = document.createElement("small");
    detalleElemento.textContent = detalle;
    tarjeta.append(detalleElemento);
  }
  return tarjeta;
}

function mostrarDatosAdministracion(id, datos) {
  const contenedor = document.querySelector(`#${id}`);
  contenedor.replaceChildren();
  if (!ultimoEstadoHost) {
    const mensaje = document.createElement("p");
    mensaje.className = "estado-administracion";
    mensaje.textContent = "Sin información reciente del agente del host.";
    contenedor.append(mensaje);
    return;
  }
  for (const dato of datos) {
    contenedor.append(crearDatoAdministracion(dato.titulo, dato.valor, dato.detalle));
  }
}

function formatearTiempoActivo(segundos) {
  if (!Number.isInteger(segundos) || segundos < 0) return null;
  const dias = Math.floor(segundos / 86400);
  const horas = Math.floor((segundos % 86400) / 3600);
  const minutos = Math.floor((segundos % 3600) / 60);
  return `${dias} d · ${horas} h · ${minutos} min`;
}

function renderizarMantenimiento() {
  const estado = ultimoEstadoHost ?? {};
  const mantenimiento = estado.mantenimiento ?? {};
  const swap = mantenimiento.swap ?? {};
  const disco = estado.disco ?? {};
  const memoria = estado.memoria ?? {};
  const docker = estado.docker ?? {};
  mostrarDatosAdministracion("panel-administracion-mantenimiento", [
    { titulo: "Tiempo activo", valor: formatearTiempoActivo(mantenimiento.tiempoActivoSegundos) },
    { titulo: "Reinicio del sistema", valor: mantenimiento.reinicioNecesario === true ? "Requerido" : "No indicado" },
    { titulo: "Carga promedio (1/5/15 min)", valor: Array.isArray(estado.cpu?.carga) ? estado.cpu.carga.join(" / ") : null },
    { titulo: "Memoria de intercambio", valor: swap.disponible ? `${swap.libreMb} MiB libres de ${swap.totalMb} MiB` : null },
    { titulo: "Almacenamiento raíz", valor: disco.disponible ? `${disco.libreGb} GB libres de ${disco.totalGb} GB (${disco.porcentaje}% usado)` : null },
    { titulo: "Memoria RAM", valor: Number.isFinite(memoria.porcentaje) ? `${memoria.porcentaje}% usada` : null },
    { titulo: "Docker", valor: docker.disponible ? `Activo · ${docker.contenedoresActivos} contenedores` : docker.error },
    { titulo: "Datos actualizados", valor: estado.momento },
  ]);
}

function renderizarVistasAdministracion() {
  renderizarMantenimiento();
}

async function actualizarSesion() {
  try {
    const respuesta = await fetch("/api/autenticacion/sesion");
    if (respuesta.status === 401) {
      window.location.assign("/iniciar-sesion");
      return;
    }
    const sesion = await respuesta.json();
    if (!respuesta.ok) throw new Error("No se pudo consultar la cuenta autenticada.");
    sesionActual = sesion;
    if (!sesion.autenticado) {
      window.location.assign("/iniciar-sesion");
      return;
    }
    document.querySelector("#perfil-usuario").textContent = sesion.nombre ?? sesion.usuario;
    actualizarAvatar(document.querySelector("#avatar"), sesion.nombre ?? sesion.usuario, sesion.fotoPerfil);
    actualizarAvatar(document.querySelector("#perfil-avatar"), sesion.nombre ?? sesion.usuario, sesion.fotoPerfil);
    actualizarEstadoFotoPerfil();
    document.querySelector("#perfil-nombre").value = sesion.nombre ?? sesion.usuario;
    document.querySelector("#perfil-nombre-usuario").value = sesion.usuario;
    document.querySelector("#perfil-rol").value =
      sesion.rol === "administrador" ? "Administrador" : "Operador";
    const administrador = sesion.rol === "administrador";
    document.querySelectorAll("[data-solo-admin]").forEach((elemento) => {
      elemento.hidden = !administrador;
    });
    document.querySelector("#panel-gestion-cuentas").hidden = !administrador;
    if (administrador) await actualizarUsuarios();
  } catch (error) {
    console.error("No se pudo consultar la sesión:", error);
    document.querySelector("#mensaje-perfil").textContent = error.message;
    document.querySelector("#mensaje-perfil").classList.add("mensaje-error");
  }
}

function mostrarMensajePerfil(mensaje, esError = false) {
  const estado = document.querySelector("#mensaje-perfil");
  estado.textContent = mensaje;
  estado.classList.toggle("mensaje-error", esError);
}

let fotoPerfilModificada = false;
let fotoPerfilPendiente = null;

document.querySelector("#foto-perfil").addEventListener("change", async (evento) => {
  const foto = evento.target.files?.[0];
  if (!foto) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(foto.type) || foto.size > 512 * 1024) {
    evento.target.value = "";
    fotoPerfilModificada = false;
    fotoPerfilPendiente = null;
    actualizarAvatar(
      document.querySelector("#perfil-avatar"),
      sesionActual?.nombre,
      sesionActual?.fotoPerfil,
    );
    actualizarEstadoFotoPerfil();
    mostrarMensajePerfil("Elige una foto PNG, JPEG o WebP de hasta 512 KiB.", true);
    return;
  }
  try {
    const bytes = new Uint8Array(await foto.arrayBuffer());
    let binario = "";
    for (const byte of bytes) binario += String.fromCharCode(byte);
    fotoPerfilPendiente = `data:${foto.type};base64,${btoa(binario)}`;
    fotoPerfilModificada = true;
    actualizarAvatar(document.querySelector("#perfil-avatar"), sesionActual?.nombre, fotoPerfilPendiente);
    actualizarEstadoFotoPerfil();
    mostrarMensajePerfil("Vista previa lista. Guarda el perfil para conservarla después de actualizar la página.");
  } catch (error) {
    evento.target.value = "";
    fotoPerfilModificada = false;
    fotoPerfilPendiente = null;
    actualizarAvatar(
      document.querySelector("#perfil-avatar"),
      sesionActual?.nombre,
      sesionActual?.fotoPerfil,
    );
    actualizarEstadoFotoPerfil();
    mostrarMensajePerfil(`No se pudo leer la foto: ${error.message}`, true);
  }
});

document.querySelector("#quitar-foto-perfil").addEventListener("click", () => {
  fotoPerfilPendiente = null;
  fotoPerfilModificada = true;
  document.querySelector("#foto-perfil").value = "";
  actualizarAvatar(document.querySelector("#perfil-avatar"), sesionActual?.nombre);
  actualizarEstadoFotoPerfil();
  mostrarMensajePerfil("Se quitará la foto al guardar el perfil.");
});

document.querySelector("#formulario-perfil").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const boton = document.querySelector("#guardar-perfil");
  boton.disabled = true;
  try {
    const respuesta = await fetch("/api/autenticacion/perfil", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nombre: document.querySelector("#perfil-nombre").value,
        contrasenaActual: document.querySelector("#perfil-contrasena-actual").value,
        nuevaContrasena: document.querySelector("#perfil-contrasena-nueva").value,
        ...(fotoPerfilModificada ? { fotoPerfil: fotoPerfilPendiente } : {}),
      }),
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.mensaje ?? "No se pudo guardar el perfil.");
    if (!Object.hasOwn(resultado, "fotoPerfil")) {
      throw new Error("El servidor guardó el perfil, pero no devolvió la foto para verificarla.");
    }
    const fotoEsperada = fotoPerfilModificada ? fotoPerfilPendiente : resultado.fotoPerfil;
    if (fotoPerfilModificada && resultado.fotoPerfil !== fotoEsperada) {
      throw new Error("El servidor no confirmó el guardado de la foto; vuelve a intentarlo.");
    }
    sesionActual = {
      ...sesionActual,
      usuario: resultado.usuario,
      nombre: resultado.nombre,
      rol: resultado.rol,
      fotoPerfil: resultado.fotoPerfil,
      autenticado: true,
    };
    document.querySelector("#perfil-usuario").textContent = resultado.nombre;
    actualizarAvatar(document.querySelector("#avatar"), resultado.nombre, resultado.fotoPerfil);
    actualizarAvatar(document.querySelector("#perfil-avatar"), resultado.nombre, resultado.fotoPerfil);
    fotoPerfilModificada = false;
    fotoPerfilPendiente = null;
    document.querySelector("#foto-perfil").value = "";
    actualizarEstadoFotoPerfil();
    document.querySelector("#perfil-contrasena-actual").value = "";
    document.querySelector("#perfil-contrasena-nueva").value = "";
    mostrarMensajePerfil("Perfil actualizado.");
  } catch (error) {
    mostrarMensajePerfil(error.message, true);
  } finally {
    boton.disabled = false;
  }
});

document.querySelector("#boton-abrir-perfil").addEventListener("click", () => {
  document.querySelector('.enlace-navegacion[data-seccion="usuarios"]').click();
  document.querySelector("#perfil-nombre").focus();
});

function mostrarCuentas({ usuarios, invitaciones }) {
  const lista = document.querySelector("#lista-cuentas");
  lista.replaceChildren();
  for (const usuario of usuarios) {
    const fila = document.createElement("article");
    fila.className = "fila-cuenta";
    const descripcion = document.createElement("div");
    const nombre = document.createElement("strong");
    nombre.textContent = usuario.nombre ?? usuario.usuario;
    const detalle = document.createElement("small");
    detalle.textContent = `${usuario.usuario} · ${usuario.rol === "administrador" ? "Administrador" : "Operador"}`;
    descripcion.append(nombre, detalle);
    fila.append(descripcion);
    if (usuario.usuario !== sesionActual?.usuario) {
      const eliminar = document.createElement("button");
      eliminar.type = "button";
      eliminar.className = "boton-cuenta";
      eliminar.dataset.eliminarUsuario = usuario.id;
      eliminar.textContent = "Eliminar cuenta";
      fila.append(eliminar);
    }
    lista.append(fila);
  }
  for (const invitacion of invitaciones) {
    const fila = document.createElement("article");
    fila.className = "fila-cuenta";
    const descripcion = document.createElement("div");
    const nombre = document.createElement("strong");
    nombre.textContent = invitacion.usuario;
    const detalle = document.createElement("small");
    detalle.textContent = `Invitación pendiente · ${invitacion.rol} · vence ${new Date(invitacion.venceEn).toLocaleString("es")}`;
    descripcion.append(nombre, detalle);
    const revocar = document.createElement("button");
    revocar.type = "button";
    revocar.className = "boton-cuenta";
    revocar.dataset.revocarInvitacion = invitacion.usuario;
    revocar.textContent = "Revocar";
    fila.append(descripcion, revocar);
    lista.append(fila);
  }
  if (!lista.childElementCount) {
    const mensaje = document.createElement("p");
    mensaje.className = "estado-administracion";
    mensaje.textContent = "No hay cuentas adicionales ni invitaciones pendientes.";
    lista.append(mensaje);
  }
}

async function actualizarUsuarios() {
  try {
    const respuesta = await fetch("/api/autenticacion/usuarios");
    const resultado = await respuesta.json();
    if (respuesta.status === 401) {
      window.location.assign("/iniciar-sesion");
      return;
    }
    if (!respuesta.ok) throw new Error(resultado.mensaje ?? "No se pudieron consultar las cuentas.");
    mostrarCuentas(resultado);
  } catch (error) {
    const lista = document.querySelector("#lista-cuentas");
    const mensaje = document.createElement("p");
    mensaje.className = "estado-administracion mensaje-error";
    mensaje.textContent = error.message;
    lista.replaceChildren(mensaje);
  }
}

document.querySelector("#formulario-invitacion").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const boton = document.querySelector("#crear-invitacion");
  const estado = document.querySelector("#mensaje-invitacion");
  const usuario = document.querySelector("#usuario-invitado").value.trim();
  const rol = document.querySelector("#rol-invitado").value;
  boton.disabled = true;
  estado.textContent = "";
  try {
    const respuesta = await fetch("/api/autenticacion/invitaciones", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario, rol }),
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.mensaje ?? "No se pudo crear la invitación.");
    document.querySelector("#resultado-invitacion").hidden = false;
    document.querySelector("#enlace-invitacion").value = resultado.enlace;
    document.querySelector("#usuario-invitado").value = "";
    estado.textContent = `Invitación para ${resultado.usuario} creada con rol ${resultado.rol}.`;
    await actualizarUsuarios();
  } catch (error) {
    estado.textContent = error.message;
    estado.classList.add("mensaje-error");
  } finally {
    boton.disabled = false;
  }
});

document.querySelector("#lista-cuentas").addEventListener("click", async (evento) => {
  const boton = evento.target.closest("button[data-eliminar-usuario], button[data-revocar-invitacion]");
  if (!boton) return;
  const esUsuario = Boolean(boton.dataset.eliminarUsuario);
  const usuario = boton.dataset.revocarInvitacion;
  if (!window.confirm(esUsuario
    ? "¿Eliminar esta cuenta? Se cerrarán sus sesiones."
    : `¿Revocar la invitación de ${usuario}?`)) return;
  boton.disabled = true;
  try {
    const destino = esUsuario
      ? `/api/autenticacion/usuarios/${encodeURIComponent(boton.dataset.eliminarUsuario)}`
      : `/api/autenticacion/invitaciones/${encodeURIComponent(usuario)}`;
    const respuesta = await fetch(destino, { method: "DELETE" });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.mensaje ?? "No se pudo completar la operación.");
    await actualizarUsuarios();
  } catch (error) {
    document.querySelector("#mensaje-invitacion").textContent = error.message;
    document.querySelector("#mensaje-invitacion").classList.add("mensaje-error");
    boton.disabled = false;
  }
});

// Consulta el endpoint permitido y actualiza únicamente los datos del resumen.
async function actualizarEstado() {
  const respuesta = await fetch("/api/estado");
  if (!respuesta.ok) {
    if (respuesta.status === 401) {
      window.location.assign("/iniciar-sesion");
      return;
    }
    const detalle = await respuesta.json().catch(() => ({}));
    throw new Error(detalle.mensaje ?? "No se pudo consultar el estado del servidor.");
  }
  const estado = await respuesta.json();
  ultimoEstadoHost = estado;
  estadoHostConectado = true;
  renderizarVistasAdministracion();
  const memoria = estado.memoria;
  const disco = estado.disco;
  const docker = estado.docker;
  mostrarContenedores(docker);

  document.querySelector("#cpu-valor").firstChild.textContent = estado.cpu.porcentaje;
  document.querySelector("#cpu-barra").style.width = `${estado.cpu.porcentaje}%`;
  document.querySelector("#cpu-detalle").textContent = `${estado.cpu.nucleos} núcleos`;
  document.querySelector("#ram-valor").firstChild.textContent = memoria.usadaMb;
  document.querySelector("#ram-barra").style.width = `${memoria.porcentaje}%`;
  document.querySelector("#ram-total").textContent = `De ${formatearNumero(memoria.totalMb / 1024)} GB`;
  document.querySelector("#ram-libre").textContent = `${formatearNumero(memoria.libreMb / 1024)} GB libres`;

  if (disco.disponible) {
    document.querySelector("#disco-valor").firstChild.textContent = disco.porcentaje;
    document.querySelector("#disco-barra").style.width = `${disco.porcentaje}%`;
    document.querySelector("#disco-total").textContent = `De ${disco.totalGb} GB`;
    document.querySelector("#disco-libre").textContent = `${disco.libreGb} GB libres`;
  }

  const valorDocker = document.querySelector("#docker-valor").firstChild;
  valorDocker.textContent = docker.disponible ? docker.contenedoresActivos : "--";
  document.querySelector("#docker-detalle").textContent = docker.disponible
    ? `Motor ${docker.version}`
    : docker.error ?? "Docker no disponible";
  const dockerEstado = document.querySelector("#docker-estado");
  dockerEstado.textContent = docker.disponible ? "● Activo" : "● No disponible";
  dockerEstado.classList.toggle("texto-verde", docker.disponible);

  document.querySelector("#estado-servidor").textContent = "Host conectado";
  document.querySelector("#estado-punto").classList.remove("sin-conexion");
  document.querySelector(".insignia-salud").classList.remove("sin-conexion");
  document.querySelector("#salud-estado").textContent = "Datos actualizados";
  document.querySelector("#salud-estado").classList.remove("sin-conexion");
  document.querySelector("#pulso-salud").classList.remove("sin-conexion");
  document.querySelector("#actividad-monitor").textContent = "Última lectura recibida del host";
  avisoTitulo.textContent = "Monitor del host conectado";
  avisoMensaje.textContent = "Métricas del host actualizadas automáticamente cada 5 segundos.";
  actualizarHora();
}

// Una falla de lectura se muestra en consola y no reemplaza datos válidos con
// valores inventados.
async function actualizarEstadoDeFormaSegura() {
  try {
    await actualizarEstado();
  } catch (error) {
    estadoHostConectado = false;
    document.querySelector("#estado-servidor").textContent = "Agente del host desconectado";
    document.querySelector("#estado-punto").classList.add("sin-conexion");
    document.querySelector(".insignia-salud").classList.add("sin-conexion");
    document.querySelector("#salud-estado").textContent = "Sin conexión";
    document.querySelector("#salud-estado").classList.add("sin-conexion");
    document.querySelector("#pulso-salud").classList.add("sin-conexion");
    document.querySelector("#actividad-monitor").textContent = "";
    avisoTitulo.textContent = "Agente de métricas pendiente";
    avisoMensaje.textContent = error.message;
  }
}

document.querySelector("#boton-actualizar").addEventListener("click", actualizarEstadoDeFormaSegura);
document.querySelector("#buscar-contenedor").addEventListener("input", async () => {
if (ultimoDocker) mostrarContenedores(ultimoDocker);
});

// Muestra la cuenta autenticada devuelta por el servidor, sin fijar un usuario.
void actualizarSesion();

// Carga el inventario inicial para mostrar proyectos recientes y poblar selectores.
void actualizarProyectos();

// Revoca la sesión en el servidor antes de regresar a la pantalla de acceso.
async function cerrarSesionActual() {
  const respuesta = await fetch("/api/autenticacion/cerrar-sesion", { method: "POST" });
  if (!respuesta.ok) {
    console.error("No se pudo cerrar la sesión.");
    return;
  }
  window.location.assign("/iniciar-sesion");
}

document.querySelector("#boton-cerrar-sesion").addEventListener("click", cerrarSesionActual);
document.querySelector("#boton-cerrar-sesion-usuarios").addEventListener("click", cerrarSesionActual);
document.querySelectorAll("[data-actualizar-host]").forEach((boton) => {
  boton.addEventListener("click", actualizarEstadoDeFormaSegura);
});

actualizarEstadoDeFormaSegura();
setInterval(actualizarEstadoDeFormaSegura, 5000);
