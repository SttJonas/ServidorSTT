// Comprueba que las páginas protegidas apunten a recursos publicados por Express.
import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directorioProyecto = fileURLToPath(new URL("../", import.meta.url));
const directorioPublico = path.join(directorioProyecto, "publico");
const recursosVendorizados = {
  "/vendor/xterm.mjs": "node_modules/@xterm/xterm/lib/xterm.mjs",
  "/vendor/xterm.css": "node_modules/@xterm/xterm/css/xterm.css",
  "/vendor/addon-fit.mjs": "node_modules/@xterm/addon-fit/lib/addon-fit.mjs",
};

test("la navegación mantiene visible solo la sección seleccionada", async () => {
  const html = await readFile(path.join(directorioPublico, "index.html"), "utf8");
  const script = await readFile(
    path.join(directorioPublico, "scripts", "panel.js"),
    "utf8",
  );
  const estilos = await readFile(
    path.join(directorioPublico, "estilos", "panel.css"),
    "utf8",
  );
  const servidor = await readFile(path.join(directorioProyecto, "src", "servidor.js"), "utf8");

  const secciones = Array.from(
    html.matchAll(/<section\b[^>]*class="[^"]*\bcontenido-seccion\b[^"]*"[^>]*id="([^"]+)"/g),
    (coincidencia) => coincidencia[1],
  );
  const destinos = Array.from(
    html.matchAll(/<button\b[^>]*class="[^"]*\benlace-navegacion\b[^"]*"[^>]*data-seccion="([^"]+)"/g),
    (coincidencia) => `seccion-${coincidencia[1]}`,
  );
  const ids = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (coincidencia) => coincidencia[1]));
  const idsDeManejadores = Array.from(
    script.matchAll(/document\.querySelector\("#([^"]+)"\)\.addEventListener/g),
    (coincidencia) => coincidencia[1],
  );
  const manejadoresHuerfanos = idsDeManejadores.filter((id) => !ids.has(id));

  assert.ok(secciones.length > 0, "Debe haber vistas principales");
  assert.deepEqual([...destinos].sort(), [...secciones].sort());
  assert.deepEqual(manejadoresHuerfanos, [], "No debe haber manejadores enlazados a elementos inexistentes");
  assert.match(script, /document\.querySelectorAll\("\.contenido-seccion"\)/);
  assert.match(script, /seccionContenido\.hidden = seccionContenido\.id !== `seccion-\$\{seccion\}`/);
  assert.match(script, /void actualizarProyectos\(\)/);
  assert.match(estilos, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(servidor, /setHeaders\(respuesta, rutaArchivo\)[\s\S]*?respuesta\.setHeader\("Cache-Control", "no-store"\)/);
  assert.match(script, /document\.querySelector\("#perfil-nombre-usuario"\)\.value = sesion\.usuario/);
  assert.doesNotMatch(script, /panel-administracion-usuarios|renderizarCuenta/);
  assert.match(html, /id="perfil-nombre-usuario"[^>]*autocomplete="username"/);
  assert.match(html, /class="insignia-salud sin-conexion"[\s\S]*?id="salud-estado">Sin conexión/);
  assert.match(script, /querySelector\("#salud-estado"\)\.classList\.add\("sin-conexion"\)/);
  assert.match(script, /querySelector\("#salud-estado"\)\.classList\.remove\("sin-conexion"\)/);
  assert.match(estilos, /\.insignia-salud\.sin-conexion\s*\{/);
  assert.match(estilos, /\.insignia-salud b\.sin-conexion\s*\{/);
  assert.match(servidor, /const proyectos = await servicioProyectos\.listar\(solicitud\.cuenta\);[\s\S]*?let estadosPhp = \[\];[\s\S]*?servicioDocker\.consultarRuntime\(\)/);
});

test("el panel ve el socket nuevo tras reiniciar el agente", async () => {
  const compose = await readFile(path.join(directorioProyecto, "docker-compose.yml"), "utf8");
  assert.match(compose, /- \/run\/swatt-monitor:\/run\/swatt-monitor:ro/);
  assert.doesNotMatch(compose, /- \/run\/swatt-monitor\/acciones\.sock:/);
});

test("los recursos CSS y JavaScript enlazados existen bajo la raíz estática", async () => {
  for (const pagina of ["index.html", "acceso.html", "registro.html"]) {
    const contenido = await readFile(path.join(directorioPublico, pagina), "utf8");
    const recursos = Array.from(
      contenido.matchAll(/<(?:link|script)\b[^>]*?(?:href|src)="(\/[^"]+)"/g),
      (coincidencia) => coincidencia[1],
    );

    if (pagina === "index.html") {
      assert.ok(recursos.length > 0, "index.html debe declarar recursos locales");
    }
    const identificadores = Array.from(
      contenido.matchAll(/\bid="([^"]+)"/g),
      (coincidencia) => coincidencia[1],
    );
    assert.equal(
      new Set(identificadores).size,
      identificadores.length,
      `${pagina} debe mantener IDs únicos`,
    );
    for (const recurso of recursos) {
      const archivo = recursosVendorizados[recurso]
        ? path.join(directorioProyecto, recursosVendorizados[recurso])
        : path.join(directorioPublico, recurso.slice(1));
      await access(archivo);
    }
  }
});

test("la vista de lenguajes y bases enlaza el catálogo y su estado real", async () => {
  const html = await readFile(path.join(directorioPublico, "index.html"), "utf8");
  const script = await readFile(
    path.join(directorioPublico, "scripts", "panel.js"),
    "utf8",
  );

  assert.match(html, /data-seccion="tecnologias"/);
  assert.match(html, /id="seccion-tecnologias"/);
  assert.match(html, /id="catalogo-runtimes"/);
  assert.match(html, /id="catalogo-bases-datos"/);
  assert.match(html, /id="lista-bases-datos"/);
  assert.match(html, /id="dialogo-gestion-proyecto"/);
  assert.match(script, /fetch\("\/api\/proyectos"\)/);
  assert.match(script, /function mostrarTecnologiasActivas/);
  assert.match(script, /dataset\.gestionProyecto = "actualizar"/);
  assert.match(script, /dataset\.gestionProyecto = "eliminar-app"/);
  assert.match(script, /dataset\.gestionProyecto = "eliminar-base"/);
  assert.match(script, /\/base-datos/);
  assert.match(script, /fotoEsperada = fotoPerfilModificada \? fotoPerfilPendiente/);
  assert.match(script, /fotoPerfil: resultado\.fotoPerfil/);
  assert.doesNotMatch(script, /sesionGuardada\.fotoPerfil !== fotoEsperada/);
  assert.match(html, /id="nombre-base-datos"/);
  assert.match(script, /nombreBaseDatos: document\.querySelector\("#nombre-base-datos"\)\.value/);
});

test("el terminal interactivo y el editor son secciones separadas", async () => {
  const html = await readFile(path.join(directorioPublico, "index.html"), "utf8");
  const script = await readFile(
    path.join(directorioPublico, "scripts", "panel.js"),
    "utf8",
  );
  const estilos = await readFile(path.join(directorioPublico, "estilos", "consola.css"), "utf8");
  const estilosProyectos = await readFile(path.join(directorioPublico, "estilos", "proyectos.css"), "utf8");
  assert.match(html, /data-seccion="terminal"/);
  assert.match(html, /data-seccion="archivos"/);
  assert.match(html, /id="seccion-terminal"/);
  assert.match(html, /id="seccion-archivos"/);
  assert.match(html, /id="terminal-emulador"/);
  assert.match(html, /class="campo-terminal"/);
  assert.match(html, /class="acciones-terminal"/);
  assert.match(html, /href="\/vendor\/xterm\.css"/);
  assert.match(html, /id="editor-contenido"/);
  assert.match(html, /href="\/estilos\/consola\.css"/);
  assert.doesNotMatch(html, /id="seccion-(?:red|seguridad)"/);
  assert.doesNotMatch(html, /UFW|Fail2ban|Tailscale|Hostname|Dirección IPv[46]/i);
  assert.match(script, /new Terminal/);
  assert.match(script, /new WebSocket/);
  assert.match(script, /evento\.data instanceof ArrayBuffer/);
  assert.match(script, /mensaje\.tipo === "lista"\) establecerEstadoTerminal\("Conectada", "conectada"\)/);
  assert.match(script, /method: "PUT"/);
  assert.match(script, /method: "DELETE"/);
  assert.match(html, /id="subir-carpeta"[^>]*webkitdirectory/);
  assert.match(script, /subirArchivosSeleccionados\(evento, true\)/);
  assert.match(html, /id="boton-abrir-perfil"/);
  assert.match(script, /#boton-abrir-perfil/);
  assert.match(html, /id="foto-perfil"[^>]*accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(script, /fotoPerfilModificada \? \{ fotoPerfil: fotoPerfilPendiente \} : \{\}/);
  assert.match(script, /#quitar-foto-perfil/);
  assert.match(script, /className = "elemento-editor-nombre"/);
  assert.match(script, /className = "elemento-editor-detalle"/);
  assert.match(estilos, /\.elemento-editor-nombre\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.match(estilos, /\.elemento-editor\s*\{[\s\S]*?grid-template-rows:\s*2\.5rem 1rem/);
  assert.match(estilos, /\.elemento-editor:hover/);
  assert.doesNotMatch(estilos, /\.editor-elemento\s*\{/);
  assert.match(estilos, /\.elemento-editor-detalle\s*\{[\s\S]*?white-space:\s*nowrap/);
  assert.match(script, /proyecto\.rutaInicio\.split\("\/"\)/);
  assert.match(html, /id="ayuda-perfil-runtime"/);
  assert.match(script, /selecciona PHP/);
  assert.match(script, /boton\.dataset\.comandoTunel/);
  assert.match(script, /127\.0\.0\.1:\$\{proyecto\.puertoLocal\}/);
  assert.match(estilosProyectos, /\.boton-tunel-ssh\s*\{/);
  assert.match(estilos, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(estilos, /height: clamp\(32rem, 72dvh, 58rem\)/);
  assert.match(estilos, /\.campo-terminal\s*\{[\s\S]*?display: grid/);
  assert.match(estilos, /\.acciones-terminal\s*\{[\s\S]*?display: flex/);
  assert.match(estilos, /#terminal-emulador/);
});

test("el README explica una instalación genérica y no contiene datos del host", async () => {
  const readme = await readFile(path.join(directorioProyecto, "README.md"), "utf8");
  const licencia = await readFile(path.join(directorioProyecto, "LICENSE"), "utf8");
  const unidad = await readFile(
    path.join(directorioProyecto, "despliegue", "swatt-monitor.service"),
    "utf8",
  );
  const dockerfile = await readFile(path.join(directorioProyecto, "Dockerfile"), "utf8");
  const entorno = await readFile(path.join(directorioProyecto, ".env.example"), "utf8");
  const seccionCreditos = readme.split("## Créditos")[1] ?? "";

  for (const seccion of [
    "Sistema operativo del servidor",
    "Herramientas de desarrollo",
    "Componentes y dependencias del panel",
    "Instalación en Debian",
    "Uso del panel",
    "Perfiles de despliegue",
    "Bases de datos",
    "Terminal interactiva",
    "API del panel",
    "Actualización",
    "Solución de problemas",
    "Seguridad y uso responsable",
    "Créditos",
  ]) {
    assert.ok(readme.includes(`## ${seccion}`) || readme.includes(`### ${seccion}`), `Falta explicar ${seccion}`);
  }
  assert.match(readme, /https:\/\/www\.debian\.org\/releases\/stable\/installmanual/);
  assert.match(readme, /https:\/\/docs\.docker\.com\/engine\/install\/debian/);
  assert.match(readme, /https:\/\/nodejs\.org\/en\/download/);
  assert.match(readme, /https:\/\/tailscale\.com\/docs\/install/);
  assert.match(readme, /consultarse, descargarse, clonarse/);
  assert.match(readme, /advertencias se refieren a ejecutar una instancia/);
  assert.match(readme, /Este\s+permiso de sistema no limita quién puede descargar/);
  assert.match(readme, /PANEL_UID/);
  assert.match(readme, /DOCKER_GID/);
  assert.match(readme, /DATABASE_URL_FILE/);
  assert.match(readme, /8 GiB de RAM/);
  assert.match(readme, /Fail2ban/);
  assert.match(readme, /reserva DHCP/);
  assert.match(readme, /sudo nmcli device wifi rescan/);
  assert.match(readme, /sudo nmcli device wifi list/);
  assert.match(readme, /sudo nmcli --ask device wifi connect/);
  assert.doesNotMatch(readme, /Minecraft/);
  assert.match(readme, /node:22-bookworm-slim node scripts\/configurar-acceso\.js/);
  assert.match(seccionCreditos, /Jonás Beren \(Swatt\)/);
  assert.match(licencia, /MIT License/);
  assert.match(licencia, /Copyright \(c\) 2026 Jonás Beren \(Swatt\)/);
  assert.doesNotMatch(readme, /Swatt-Debian|100\.109\.\d+\.\d+|tail0bd79f|4c:24:ce:bd:1d:26/);
  assert.match(readme, /RUTA_PROYECTOS=\/srv\/panel\/proyectos/);
  assert.match(unidad, /^User=panel$/m);
  assert.match(unidad, /^Environment=DIRECTORIO_PROYECTOS=\/srv\/panel\/proyectos$/m);
  assert.match(unidad, /^ReadWritePaths=\/srv\/panel\/proyectos$/m);
  assert.match(entorno, /^RUTA_PROYECTOS=\/srv\/panel\/proyectos$/m);
  assert.match(entorno, /^RUTA_DATOS_PANEL=\/srv\/panel\/datos-panel$/m);
  assert.match(dockerfile, /^FROM node:22-bookworm-slim$/m);
  assert.match(readme, /Node\.js 22 LTS/);
});

test("la gestión de invitaciones permite elegir el rol de la cuenta", async () => {
  const html = await readFile(path.join(directorioPublico, "index.html"), "utf8");
  const registro = await readFile(path.join(directorioPublico, "registro.html"), "utf8");
  const registroScript = await readFile(
    path.join(directorioPublico, "scripts", "registro.js"),
    "utf8",
  );
  const script = await readFile(
    path.join(directorioPublico, "scripts", "panel.js"),
    "utf8",
  );

  assert.match(html, /id="rol-invitado"/);
  assert.match(html, /value="operador"/);
  assert.match(html, /value="administrador"/);
  assert.match(script, /const rol = document\.querySelector\("#rol-invitado"\)\.value/);
  assert.match(html, /acceso total/i);
  assert.match(registro, /src="\/scripts\/registro\.js"/);
  assert.match(registroScript, /resultado\.rol === "administrador"/);
  assert.match(registroScript, /Rol: \$\{rol\}/);
});

test("los runtimes ofrecen enlace Tailscale cuando está habilitado y conservan el túnel SSH", async () => {
  const script = await readFile(
    path.join(directorioPublico, "scripts", "panel.js"),
    "utf8",
  );
  const estilos = await readFile(
    path.join(directorioPublico, "estilos", "proyectos.css"),
    "utf8",
  );

  assert.match(script, /proyecto\.urlPrivada/);
  assert.match(script, /Abrir aplicación en Tailscale/);
  assert.match(script, /Copiar comando del túnel/);
  assert.match(estilos, /\.enlace-acceso-tailnet/);
});

test("el acceso explica que las cuentas nuevas requieren invitación", async () => {
  const html = await readFile(path.join(directorioPublico, "acceso.html"), "utf8");
  const registro = await readFile(path.join(directorioPublico, "registro.html"), "utf8");
  const readme = await readFile(path.join(directorioProyecto, "README.md"), "utf8");

  assert.match(html, /Panel de administración del servidor/);
  assert.match(html, /solo se crean mediante una invitación/);
  assert.match(html, /src="\/scripts\/acceso\.js"/);
  assert.match(registro, /src="\/scripts\/registro\.js"/);
  assert.doesNotMatch(html, /<script>([\s\S]*?)<\/script>/i);
  assert.doesNotMatch(registro, /<script>([\s\S]*?)<\/script>/i);
  assert.match(readme, /tailscale funnel --bg 3000/);
  assert.match(readme, /\*\*no\*\* habilita el registro abierto/s);
});
