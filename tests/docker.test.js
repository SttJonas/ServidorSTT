// Comprueba que solo solicitudes de contenedor limitadas llegan al agente.
import test from "node:test";
import assert from "node:assert/strict";
import { crearServicioDocker } from "../src/servicios/docker.js";

const solicitudValida = {
  id: "0123456789abcdef",
  accion: "detener",
  nombreConfirmado: "aplicacion-prueba",
};

test("envía una acción permitida con confirmación escrita exacta", async () => {
  const solicitudes = [];
  const servicio = crearServicioDocker({
    enviarSolicitud: async (solicitud) => {
      solicitudes.push(solicitud);
      return { correcto: true, accion: "detener", nombre: "aplicacion-prueba" };
    },
  });

  const resultado = await servicio.ejecutarAccion(solicitudValida);

  assert.equal(resultado.correcto, true);
  assert.deepEqual(solicitudes, [solicitudValida]);
});

test("rechaza IDs inválidos antes de contactar al agente", async () => {
  let enviada = false;
  const servicio = crearServicioDocker({
    enviarSolicitud: async () => {
      enviada = true;
      return { correcto: true };
    },
  });

  const resultado = await servicio.ejecutarAccion({ ...solicitudValida, id: "../../etc/passwd" });

  assert.equal(resultado.codigo, "identificador_invalido");
  assert.equal(enviada, false);
});

test("rechaza comandos o acciones no permitidas", async () => {
  let enviada = false;
  const servicio = crearServicioDocker({
    enviarSolicitud: async () => {
      enviada = true;
      return { correcto: true };
    },
  });

  const resultado = await servicio.ejecutarAccion({
    ...solicitudValida,
    accion: "exec",
  });

  assert.equal(resultado.codigo, "accion_no_permitida");
  assert.equal(enviada, false);
});

test("requiere nombre de confirmación no vacío y acotado", async () => {
  let enviada = false;
  const servicio = crearServicioDocker({
    enviarSolicitud: async () => {
      enviada = true;
      return { correcto: true };
    },
  });

  const resultado = await servicio.ejecutarAccion({
    ...solicitudValida,
    nombreConfirmado: " ",
  });

  assert.equal(resultado.codigo, "confirmacion_invalida");
  assert.equal(enviada, false);
});

test("remite solo una solicitud válida del runtime PHP fijado", async () => {
  const solicitudes = [];
  const servicio = crearServicioDocker({
    enviarSolicitud: async (solicitud) => {
      solicitudes.push(solicitud);
      return { correcto: true, nombre: "Proyecto PHP", puerto: 18080 };
    },
  });
  const id = "01234567-89ab-4cde-8fab-0123456789ab";
  const resultado = await servicio.desplegarPhp({ id, nombreConfirmado: "Proyecto PHP" });

  assert.deepEqual(resultado, { correcto: true, nombre: "Proyecto PHP", puerto: 18080 });
  assert.deepEqual(solicitudes, [{
    accion: "desplegar_php",
    id,
    nombreConfirmado: "Proyecto PHP",
  }]);
});

test("rechaza IDs y confirmaciones PHP inválidas antes de contactar al agente", async () => {
  let enviada = false;
  const servicio = crearServicioDocker({
    enviarSolicitud: async () => {
      enviada = true;
      return { correcto: true };
    },
  });
  const id = "01234567-89ab-4cde-8fab-0123456789ab";

  const idInvalido = await servicio.desplegarPhp({ id: "../../etc/passwd", nombreConfirmado: "Proyecto" });
  const nombreInvalido = await servicio.desplegarPhp({ id, nombreConfirmado: " " });

  assert.equal(idInvalido.codigo, "identificador_invalido");
  assert.equal(nombreInvalido.codigo, "confirmacion_invalida");
  assert.equal(enviada, false);
});

test("envía perfiles de aplicación permitidos y valida el puerto de respuesta", async () => {
  const solicitudes = [];
  const servicio = crearServicioDocker({
    enviarSolicitud: async (solicitud) => {
      solicitudes.push(solicitud);
      return { correcto: true, nombre: "Aplicación", puerto: 18082 };
    },
  });
  const id = "01234567-89ab-4cde-8fab-0123456789ab";
  const resultado = await servicio.desplegarAplicacion({
    id,
    perfil: "node",
    nombreConfirmado: "Aplicación",
  });

  assert.equal(resultado.perfil, "node");
  assert.deepEqual(solicitudes, [{
    accion: "desplegar_app",
    id,
    perfil: "node",
    nombreConfirmado: "Aplicación",
  }]);
});

test("conserva la ruta de inicio de un PHP cuyo index está en una subcarpeta", async () => {
  const solicitudes = [];
  const servicio = crearServicioDocker({
    enviarSolicitud: async (solicitud) => {
      solicitudes.push(solicitud);
      return {
        correcto: true,
        nombre: "Prueba2",
        puerto: 18083,
        rutaInicio: "Login/HTML/index.php",
      };
    },
  });
  const id = "01234567-89ab-4cde-8fab-0123456789ab";

  const resultado = await servicio.desplegarAplicacion({
    id,
    perfil: "php",
    nombreConfirmado: "Prueba2",
  });

  assert.equal(resultado.rutaInicio, "Login/HTML/index.php");
  assert.equal(solicitudes[0].accion, "desplegar_php");
});

test("rechaza perfiles de aplicación no incluidos en la lista permitida", async () => {
  let enviada = false;
  const servicio = crearServicioDocker({
    enviarSolicitud: async () => {
      enviada = true;
      return { correcto: true };
    },
  });

  const resultado = await servicio.desplegarAplicacion({
    id: "01234567-89ab-4cde-8fab-0123456789ab",
    perfil: "docker-compose",
    nombreConfirmado: "Aplicación",
  });

  assert.equal(resultado.codigo, "perfil_no_permitido");
  assert.equal(enviada, false);
});

test("consulta estados de proyecto solo con respuesta válida del agente", async () => {
  const servicio = crearServicioDocker({
    enviarSolicitud: async (solicitud) => {
      assert.deepEqual(solicitud, { accion: "php_estado" });
      return {
        correcto: true,
        proyectos: [{
          id: "01234567-89ab-4cde-8fab-0123456789ab",
          nombre: "Proyecto PHP",
          estado: "activo",
          puerto: 18080,
          rutaInicio: "Login/HTML/index.php",
        }],
      };
    },
  });

  const [proyecto] = await servicio.consultarRuntime();
  assert.equal(proyecto.estado, "activo");
  assert.equal(proyecto.rutaInicio, "Login/HTML/index.php");
});

test("acepta enlaces de aplicación solo dentro del rango IPv4 de Tailscale", async () => {
  const servicio = crearServicioDocker({
    enviarSolicitud: async () => ({
      correcto: true,
      proyectos: [{
        id: "01234567-89ab-4cde-8fab-0123456789ab",
        nombre: "Proyecto PHP",
        estado: "activo",
        puerto: 18080,
        urlPrivada: "http://100.109.252.50:18080",
      }],
    }),
  });

  assert.equal((await servicio.consultarRuntime())[0].urlPrivada, "http://100.109.252.50:18080");
});

test("rechaza enlaces de runtime fuera de la tailnet o en otro puerto", async () => {
  for (const urlPrivada of [
    "http://192.168.1.20:18080",
    "http://100.109.252.50:18081",
  ]) {
    const servicio = crearServicioDocker({
      enviarSolicitud: async () => ({
        correcto: true,
        proyectos: [{
          id: "01234567-89ab-4cde-8fab-0123456789ab",
          nombre: "Proyecto PHP",
          estado: "activo",
          puerto: 18080,
          urlPrivada,
        }],
      }),
    });
    await assert.rejects(servicio.consultarRuntime(), /estado de runtime inválido/);
  }
});

test("rechaza una respuesta de estado PHP con puerto ajeno al rango reservado", async () => {
  const servicio = crearServicioDocker({
    enviarSolicitud: async () => ({
      correcto: true,
      proyectos: [{
        id: "01234567-89ab-4cde-8fab-0123456789ab",
        nombre: "Proyecto PHP",
        estado: "activo",
        puerto: 443,
      }],
    }),
  });

  test("rechaza rutas de entrada fuera de la carpeta raíz de la aplicación", async () => {
    const servicio = crearServicioDocker({
      enviarSolicitud: async () => ({
        correcto: true,
        proyectos: [{
          id: "01234567-89ab-4cde-8fab-0123456789ab",
          nombre: "Proyecto PHP",
          estado: "activo",
          puerto: 18080,
          rutaInicio: "../../etc/passwd",
        }],
      }),
    });

    await assert.rejects(servicio.consultarRuntime(), /estado de runtime inválido/);
  });

  await assert.rejects(servicio.consultarRuntime(), /estado de runtime inválido/);
});

test("remite acciones PHP solo para el proyecto confirmado", async () => {
  const solicitudes = [];
  const servicio = crearServicioDocker({
    enviarSolicitud: async (solicitud) => {
      solicitudes.push(solicitud);
      return {
        correcto: true,
        nombre: "Proyecto PHP",
        estado: "detenido",
        puerto: 18080,
      };
    },
  });
  const id = "01234567-89ab-4cde-8fab-0123456789ab";
  const resultado = await servicio.operarRuntime({
    id,
    accion: "detener",
    nombreConfirmado: "Proyecto PHP",
  });

  assert.equal(resultado.estado, "detenido");
  assert.deepEqual(solicitudes, [{
    accion: "php_detener",
    id,
    nombreConfirmado: "Proyecto PHP",
  }]);
});

test("crea una base de datos de motor permitido y valida la contraseña recibida", async () => {
  const solicitudes = [];
  const servicio = crearServicioDocker({
    enviarSolicitud: async (solicitud) => {
      solicitudes.push(solicitud);
      return {
        correcto: true,
        motor: "postgresql",
        host: "base-datos",
        puerto: 5432,
        nombre: "inventario_app",
        usuario: "swatt",
        contrasena: "a".repeat(64),
        rutaDatos: "/var/lib/docker/volumes/swatt-dbdata-test/_data",
      };
    },
  });
  const id = "01234567-89ab-4cde-8fab-0123456789ab";
  const resultado = await servicio.crearBaseDatos({
    id,
    motor: "postgresql",
    nombreConfirmado: "Proyecto PHP",
    nombreBaseDatos: "inventario_app",
  });

  assert.equal(resultado.correcto, true);
  assert.equal(resultado.contrasena.length, 64);
  assert.equal(resultado.rutaDatos, "/var/lib/docker/volumes/swatt-dbdata-test/_data");
  assert.deepEqual(solicitudes, [{
    accion: "crear_base_datos",
    id,
    motor: "postgresql",
    nombreConfirmado: "Proyecto PHP",
    nombreBaseDatos: "inventario_app",
  }]);
});

test("rechaza motores de base de datos inválidos antes de contactar al agente", async () => {
  let enviada = false;
  const servicio = crearServicioDocker({
    enviarSolicitud: async () => {
      enviada = true;
      return { correcto: true };
    },
  });

  const resultado = await servicio.crearBaseDatos({
    id: "01234567-89ab-4cde-8fab-0123456789ab",
    motor: "docker-compose",
    nombreConfirmado: "Proyecto PHP",
  });

  assert.equal(resultado.codigo, "motor_no_permitido");
  assert.equal(enviada, false);
});

test("rechaza nombres de base de datos no seguros antes de contactar al agente", async () => {
  let enviada = false;
  const servicio = crearServicioDocker({
    enviarSolicitud: async () => {
      enviada = true;
      return { correcto: true };
    },
  });

  const resultado = await servicio.crearBaseDatos({
    id: "01234567-89ab-4cde-8fab-0123456789ab",
    motor: "postgresql",
    nombreConfirmado: "Proyecto PHP",
    nombreBaseDatos: 'base"; DROP DATABASE swatt;--',
  });

  assert.equal(resultado.codigo, "nombre_base_invalido");
  assert.equal(enviada, false);
});

test("remite la lectura de credenciales solo para motor y nombre confirmados", async () => {
  const solicitudes = [];
  const servicio = crearServicioDocker({
    enviarSolicitud: async (solicitud) => {
      solicitudes.push(solicitud);
      return {
        correcto: true,
        motor: "mongodb",
        host: "base-datos",
        puerto: 27017,
        nombre: "swatt",
        usuario: "swatt",
        contrasena: "b".repeat(64),
        rutaDatos: "/var/lib/docker/volumes/swatt-dbdata-test/_data",
      };
    },
  });
  const id = "01234567-89ab-4cde-8fab-0123456789ab";
  const resultado = await servicio.consultarCredencialesBaseDatos({
    id,
    motor: "mongodb",
    nombreConfirmado: "Proyecto PHP",
    nombreBaseDatos: "swatt",
  });

  assert.equal(resultado.contrasena, "b".repeat(64));
  assert.deepEqual(solicitudes, [{
    accion: "credenciales_base_datos",
    id,
    motor: "mongodb",
    nombreConfirmado: "Proyecto PHP",
    nombreBaseDatos: "swatt",
  }]);
});

test("archiva proyectos solo con respuesta confirmada del agente", async () => {
  const solicitudes = [];
  const servicio = crearServicioDocker({
    enviarSolicitud: async (solicitud) => {
      solicitudes.push(solicitud);
      return { correcto: true, nombre: "Proyecto", baseDatosConservada: true };
    },
  });
  const id = "01234567-89ab-4cde-8fab-0123456789ab";
  const resultado = await servicio.archivarProyecto({ id, nombreConfirmado: "Proyecto" });

  assert.deepEqual(resultado, { correcto: true, nombre: "Proyecto", baseDatosConservada: true });
  assert.deepEqual(solicitudes, [{ accion: "archivar_proyecto", id, nombreConfirmado: "Proyecto" }]);
});

test("solicita eliminar una base persistente por separado y valida la respuesta", async () => {
  const solicitudes = [];
  const servicio = crearServicioDocker({
    enviarSolicitud: async (solicitud) => {
      solicitudes.push(solicitud);
      return { correcto: true, nombre: "Proyecto" };
    },
  });
  const id = "01234567-89ab-4cde-8fab-0123456789ab";
  const resultado = await servicio.eliminarBaseDatos({
    id,
    motor: "postgresql",
    nombreConfirmado: "Proyecto",
    nombreBaseDatos: "swatt",
  });

  assert.deepEqual(resultado, { correcto: true, nombre: "Proyecto" });
  assert.deepEqual(solicitudes, [{
    accion: "eliminar_base_datos",
    id,
    motor: "postgresql",
    nombreConfirmado: "Proyecto",
    nombreBaseDatos: "swatt",
  }]);
});

test("envía comandos limitados a la consola efímera del proyecto", async () => {
  const solicitudes = [];
  const servicio = crearServicioDocker({
    enviarSolicitud: async (solicitud) => {
      solicitudes.push(solicitud);
      return {
        correcto: true,
        salida: "src",
        codigoSalida: 0,
        directorio: ".",
        limiteTiempo: false,
        salidaRecortada: false,
      };
    },
  });
  const id = "01234567-89ab-4cde-8fab-0123456789ab";
  const resultado = await servicio.ejecutarConsola({
    id,
    nombreConfirmado: "Proyecto propio",
    comando: "ls",
    directorio: ".",
  });

  assert.equal(resultado.correcto, true);
  assert.deepEqual(solicitudes, [{
    accion: "consola_proyecto",
    id,
    nombreConfirmado: "Proyecto propio",
    comando: "ls",
    directorio: ".",
  }]);
});

test("rechaza comandos de consola demasiado largos y rutas absolutas", async () => {
  let enviada = false;
  const servicio = crearServicioDocker({
    enviarSolicitud: async () => {
      enviada = true;
      return { correcto: true };
    },
  });
  const base = {
    id: "01234567-89ab-4cde-8fab-0123456789ab",
    nombreConfirmado: "Proyecto propio",
  };
  assert.equal(
    (await servicio.ejecutarConsola({ ...base, comando: "x".repeat(2049) })).codigo,
    "comando_invalido",
  );
  assert.equal(
    (await servicio.ejecutarConsola({ ...base, comando: "pwd", directorio: "/etc" })).codigo,
    "directorio_invalido",
  );
  assert.equal(enviada, false);
});

test("valida las dimensiones de una terminal interactiva antes de abrir el socket", async () => {
  const servicio = crearServicioDocker({
    enviarSolicitud: async () => assert.fail("No debe usar el socket JSON para abrir una sesión PTY."),
  });
  await assert.rejects(
    servicio.abrirTerminal({
      id: "01234567-89ab-4cde-8fab-0123456789ab",
      nombreConfirmado: "Proyecto propio",
      columnas: 400,
      filas: 30,
    }),
    /configuración de terminal no es válida/,
  );
});
