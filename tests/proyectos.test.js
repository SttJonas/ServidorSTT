// Verifica límites de origen y persistencia del importador sin usar Internet.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crearServicioProyectos, normalizarRepositorio } from "../src/servicios/proyectos.js";

const cuentaPrueba = { id: "usuario-prueba", rol: "operador" };

test("solo admite URLs HTTPS públicas de GitHub o GitLab", () => {
  assert.equal(
    normalizarRepositorio("https://github.com/ejemplo/aplicacion"),
    "https://github.com/ejemplo/aplicacion.git",
  );
  assert.equal(
    normalizarRepositorio("https://gitlab.com/grupo/subgrupo/aplicacion.git"),
    "https://gitlab.com/grupo/subgrupo/aplicacion.git",
  );
  for (const url of [
    "http://github.com/ejemplo/app",
    "https://github.com.ejemplo.invalid/usuario/app",
    "https://usuario:clave@github.com/usuario/app",
    "https://github.com/usuario/app?token=secreto",
    "https://127.0.0.1/usuario/app",
    "file:///etc/passwd",
  ]) {
    assert.throws(() => normalizarRepositorio(url));
  }
});

test("importa y persiste el repositorio como pendiente de revisión", async () => {
  const raiz = await mkdtemp(path.join(os.tmpdir(), "swatt-proyectos-"));
  let llamadasClon = 0;
  const servicio = crearServicioProyectos({
    directorio: raiz,
    clonar: async (_repositorio, _rama, destino) => {
      llamadasClon += 1;
      await mkdir(destino);
      await mkdir(path.join(destino, ".git"));
      await writeFile(path.join(destino, ".git", "config"), "no debe quedar publicado");
      await writeFile(path.join(destino, "compose.yaml"), "services: {}\n");
      return "0123456789ab";
    },
  });
  try {
    const proyecto = await servicio.importar({
      nombre: "Mi aplicación",
      repositorio: "https://github.com/ejemplo/aplicacion",
      rama: "main",
    }, "usuario-prueba");
    assert.equal(proyecto.estado, "pendiente_revision");
    assert.deepEqual(proyecto.archivosCompose, ["compose.yaml"]);
    assert.equal(proyecto.commit, "0123456789ab");
    const { propietarioId: _propietarioId, ...proyectoVisible } = proyecto;
    assert.deepEqual(await servicio.listar(cuentaPrueba), [{ ...proyectoVisible, puedeDesplegar: true }]);
    assert.equal((await servicio.leerCompose(proyecto.id, "compose.yaml", cuentaPrueba)).contenido, "services: {}\n");
    await assert.rejects(readFile(path.join(raiz, proyecto.id, ".git", "config"), "utf8"), { code: "ENOENT" });
    assert.equal(llamadasClon, 1);

    await assert.rejects(
      servicio.leerCompose(proyecto.id, "../.registro-swatt.json", cuentaPrueba),
      (error) => error.codigo === "archivo_compose_invalido",
    );
    await assert.rejects(
      servicio.importar({
        nombre: "Otro nombre",
        repositorio: "https://github.com/ejemplo/aplicacion",
        rama: "main",
      }, "usuario-prueba"),
      (error) => error.codigo === "repositorio_duplicado",
    );
    assert.equal(llamadasClon, 1);

    const registro = JSON.parse(await readFile(path.join(raiz, ".registro-swatt.json"), "utf8"));
    assert.equal(registro[0].estado, "pendiente_revision");
  } finally {
    await rm(raiz, { recursive: true, force: true });
  }
});

test("rechaza ramas con opciones o rutas inválidas antes de clonar", async () => {
  const raiz = await mkdtemp(path.join(os.tmpdir(), "swatt-proyectos-"));
  let llamadasClon = 0;
  const servicio = crearServicioProyectos({
    directorio: raiz,
    clonar: async () => {
      llamadasClon += 1;
      return "no-debe-ejecutarse";
    },
  });
  try {
    await assert.rejects(
      servicio.importar({
        nombre: "Proyecto",
        repositorio: "https://github.com/ejemplo/aplicacion",
        rama: "--upload-pack=arbitrario",
      }, "usuario-prueba"),
      (error) => error.codigo === "rama_invalida",
    );
    assert.equal(llamadasClon, 0);
  } finally {
    await rm(raiz, { recursive: true, force: true });
  }
});

test("limita la lectura de Compose a 256 KiB", async () => {
  const raiz = await mkdtemp(path.join(os.tmpdir(), "swatt-proyectos-"));
  const servicio = crearServicioProyectos({
    directorio: raiz,
    clonar: async (_repositorio, _rama, destino) => {
      await mkdir(destino);
      await writeFile(path.join(destino, "compose.yaml"), Buffer.alloc(262_145, 65));
      return "0123456789ab";
    },
  });
  try {
    const proyecto = await servicio.importar({
      nombre: "Proyecto grande",
      repositorio: "https://gitlab.com/ejemplo/aplicacion",
      rama: "main",
    }, "usuario-prueba");
    await assert.rejects(
      servicio.leerCompose(proyecto.id, "compose.yaml", cuentaPrueba),
      (error) => error.estadoHttp === 413,
    );
  } finally {
    await rm(raiz, { recursive: true, force: true });
  }
});

test("retira repositorios que exceden el límite de almacenamiento", async () => {
  const raiz = await mkdtemp(path.join(os.tmpdir(), "swatt-proyectos-"));
  let destinoClonado;
  const servicio = crearServicioProyectos({
    directorio: raiz,
    clonar: async (_repositorio, _rama, destino) => {
      destinoClonado = destino;
      await mkdir(destino);
      const archivo = await open(path.join(destino, "archivo-grande.bin"), "w");
      await archivo.truncate(268_435_457);
      await archivo.close();
      return "0123456789ab";
    },
  });
  try {
    await assert.rejects(
      servicio.importar({
        nombre: "Repositorio grande",
        repositorio: "https://github.com/ejemplo/grande",
        rama: "main",
      }, "usuario-prueba"),
      (error) => error.codigo === "repositorio_demasiado_grande" && error.estadoHttp === 413,
    );
    await assert.rejects(readFile(path.join(destinoClonado, "archivo-grande.bin")), { code: "ENOENT" });
    assert.deepEqual(await servicio.listar(cuentaPrueba), []);
  } finally {
    await rm(raiz, { recursive: true, force: true });
  }
});

test("limita la consola y edición al proyecto de su propietario", async () => {
  const raiz = await mkdtemp(path.join(os.tmpdir(), "swatt-propietarios-"));
  const servicio = crearServicioProyectos({
    directorio: raiz,
    clonar: async (_repositorio, _rama, destino) => {
      await mkdir(destino);
      await writeFile(path.join(destino, "index.html"), "<h1>Inicial</h1>");
      return "0123456789ab";
    },
  });
  const cuentaA = { id: "cuenta-a", rol: "operador" };
  const cuentaB = { id: "cuenta-b", rol: "operador" };
  try {
    const proyecto = await servicio.importar({
      nombre: "Proyecto de A",
      repositorio: "https://github.com/ejemplo/proyecto-a",
      rama: "main",
    }, cuentaA.id);
    assert.equal((await servicio.listar(cuentaA)).length, 1);
    assert.deepEqual(await servicio.listar(cuentaB), []);
    assert.equal((await servicio.listar({ id: "admin", rol: "administrador" })).length, 1);
    await assert.rejects(
      servicio.obtener(proyecto.id, cuentaB),
      (error) => error.estadoHttp === 404,
    );

    await servicio.guardarArchivo(proyecto.id, "src/app.js", "console.log('A');\n", cuentaA);
    assert.deepEqual(
      await servicio.leerArchivo(proyecto.id, "src/app.js", cuentaA),
      { ruta: "src/app.js", contenido: "console.log('A');\n" },
    );
    assert.deepEqual(
      (await servicio.listarArchivos(proyecto.id, "src", cuentaA)).map((archivo) => archivo.nombre),
      ["app.js"],
    );
    await assert.rejects(
      servicio.leerArchivo(proyecto.id, "src/app.js", cuentaB),
      (error) => error.estadoHttp === 404,
    );
    await assert.rejects(
      servicio.guardarArchivo(proyecto.id, "../../.registro-swatt.json", "[]", cuentaA),
      (error) => error.codigo === "ruta_invalida",
    );
    const archivoBinario = Buffer.from([0, 255, 1, 2, 128]);
    await servicio.guardarArchivo(
      proyecto.id,
      "media/imagen.bin",
      undefined,
      cuentaA,
      archivoBinario.toString("base64"),
    );
    assert.deepEqual(
      await readFile(path.join(raiz, proyecto.id, "media", "imagen.bin")),
      archivoBinario,
    );
    await assert.rejects(
      servicio.leerArchivo(proyecto.id, "media/imagen.bin", cuentaA),
      (error) => error.codigo === "archivo_binario",
    );
    await servicio.eliminarArchivo(proyecto.id, "src/app.js", cuentaA);
    await assert.rejects(
      servicio.leerArchivo(proyecto.id, "src/app.js", cuentaA),
      { code: "ENOENT" },
    );
  } finally {
    await rm(raiz, { recursive: true, force: true });
  }
});

test("valida metadatos de bases de datos y nunca admite credenciales en el inventario", async () => {
  const raiz = await mkdtemp(path.join(os.tmpdir(), "swatt-proyectos-"));
  const servicio = crearServicioProyectos({
    directorio: raiz,
    clonar: async (_repositorio, _rama, destino) => {
      await mkdir(destino);
      return "0123456789ab";
    },
  });
  try {
    const proyecto = await servicio.importar({
      nombre: "Aplicación con base",
      repositorio: "https://github.com/ejemplo/con-base",
      rama: "main",
    }, "usuario-prueba");
    const rutaRegistro = path.join(raiz, ".registro-swatt.json");
    const registro = JSON.parse(await readFile(rutaRegistro, "utf8"));
    const sufijo = proyecto.id.replaceAll("-", "").slice(0, 12);
    registro[0] = {
      ...registro[0],
      estado: "desplegado",
      runtime: "node:22-bookworm-slim",
      runtimePerfil: "node",
      puertoInterno: 3000,
      puertoLocal: 18080,
      contenedor: `swatt-app-${sufijo}`,
      estadoRuntime: "activo",
      baseDatos: {
        motor: "postgresql",
        contenedor: `swatt-db-${sufijo}`,
        volumen: `swatt-dbdata-${sufijo}`,
        nombre: "inventario_app",
        usuario: "swatt",
        puerto: 5432,
        rutaDatos: "/var/lib/docker/volumes/swatt-dbdata-example/_data",
      },
    };
    await writeFile(rutaRegistro, JSON.stringify(registro));
    assert.equal((await servicio.listar(cuentaPrueba))[0].baseDatos.motor, "postgresql");
    assert.equal((await servicio.listar(cuentaPrueba))[0].baseDatos.nombre, "inventario_app");

    registro[0].baseDatos.contrasena = "no-debe-persistirse";
    await writeFile(rutaRegistro, JSON.stringify(registro));
    await assert.rejects(servicio.listar(cuentaPrueba), /registro de proyectos/);
  } finally {
    await rm(raiz, { recursive: true, force: true });
  }
});

test("al borrar un proyecto conserva su base archivada y la restringe al propietario", async () => {
  const raiz = await mkdtemp(path.join(os.tmpdir(), "swatt-borrado-"));
  const servicio = crearServicioProyectos({
    directorio: raiz,
    clonar: async (_repositorio, _rama, destino) => {
      await mkdir(destino);
      await writeFile(path.join(destino, "index.html"), "proyecto");
      return "0123456789ab";
    },
  });
  try {
    const proyecto = await servicio.importar({
      nombre: "Proyecto archivado",
      repositorio: "https://github.com/ejemplo/archivado",
      rama: "main",
    }, cuentaPrueba.id);
    const rutaRegistro = path.join(raiz, ".registro-swatt.json");
    const registro = JSON.parse(await readFile(rutaRegistro, "utf8"));
    const sufijo = proyecto.id.replaceAll("-", "").slice(0, 12);
    registro[0] = {
      ...registro[0],
      estado: "archivado",
      baseDatos: {
        motor: "postgresql",
        contenedor: `swatt-db-${sufijo}`,
        volumen: `swatt-dbdata-${sufijo}`,
        nombre: "swatt",
        usuario: "swatt",
        puerto: 5432,
      },
    };
    await writeFile(rutaRegistro, JSON.stringify(registro));

    await assert.rejects(
      servicio.eliminarProyecto(proyecto.id, { id: "otra-cuenta", rol: "operador" }),
      (error) => error.estadoHttp === 404,
    );
    const resultado = await servicio.eliminarProyecto(proyecto.id, cuentaPrueba);
    assert.deepEqual(resultado, { proyecto: "Proyecto archivado", baseDatosConservada: true });
    await assert.rejects(readFile(path.join(raiz, proyecto.id, "index.html")), { code: "ENOENT" });
    assert.equal((await servicio.listar(cuentaPrueba))[0].estado, "archivado");

    await servicio.eliminarBaseArchivada(proyecto.id, cuentaPrueba);
    assert.deepEqual(await servicio.listar(cuentaPrueba), []);
  } finally {
    await rm(raiz, { recursive: true, force: true });
  }
});
