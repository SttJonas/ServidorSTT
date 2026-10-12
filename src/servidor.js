// Importa Express para crear el servidor HTTP.
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";

// Importa la configuración validada del proyecto.
import { entorno } from "../configuracion/entorno.js";
import { crearAutenticacion, crearServicioCuentasPhp } from "./servicios/autenticacion.js";
import { servicioDocker } from "./servicios/docker.js";
import { obtenerEstadoSistema } from "./servicios/estado-sistema.js";
import { servicioProyectos } from "./servicios/proyectos.js";
import { protegerRespuestaWeb } from "./servicios/seguridad-http.js";

// Crea la aplicación web sin exponer todavía operaciones administrativas.
const aplicacion = express();
aplicacion.disable("x-powered-by");
aplicacion.locals.cookieSeguro = entorno.cookieSegura;
const servicioUsuarios = crearServicioCuentasPhp({
  url: "http://php-cuentas:8080/",
  secreto: entorno.cuentasApiSecreto,
  archivoUsuarios: entorno.archivoUsuarios,
});
const autenticar = crearAutenticacion({
  usuarioAdministrador: entorno.usuarioAdministrador,
  hashContrasena: entorno.hashContrasenaAdministrador,
  cookieSegura: entorno.cookieSegura,
  archivoUsuarios: entorno.archivoUsuarios,
  servicioUsuarios,
});
await autenticar.inicializar();

// Aplica defensas del navegador incluso a respuestas de error generadas antes de una ruta.
aplicacion.use(protegerRespuestaWeb({ cookieSegura: entorno.cookieSegura }));

// Permite JSON con un límite que cubre archivos y fotos de perfil codificados.
aplicacion.use(express.json({ limit: "2mb" }));

function mensajeAgenteNoDisponible(error, operacion) {
  if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
    return `El panel no puede conectar con el socket del agente para ${operacion}. Comprueba que swatt-monitor.service esté activo y recrea el panel con "docker compose up -d --force-recreate" para renovar el montaje del socket.`;
  }
  return `El agente del host no pudo completar ${operacion}. Revisa los registros del servicio swatt-monitor.`;
}

// Confía solo en el proxy reverso local para detectar una solicitud HTTPS.
aplicacion.set("trust proxy", "loopback");

// Expone un endpoint pequeño para comprobar que el servicio está funcionando.
aplicacion.get("/api/salud", (_solicitud, respuesta) => {
  respuesta.json({
    estado: "correcto",
    servicio: "panel-servidor",
    entorno: entorno.modo,
  });
});

// Configura la página de acceso y las rutas de autenticación sin exponer el panel.
autenticar.configurarRutas(aplicacion, (respuesta) => {
  respuesta.sendFile(fileURLToPath(new URL("../publico/acceso.html", import.meta.url)));
}, (respuesta) => {
  respuesta.sendFile(fileURLToPath(new URL("../publico/registro.html", import.meta.url)));
});

// Publica únicamente la hoja compartida por las dos pantallas de autenticación.
aplicacion.get("/estilos/acceso.css", (_solicitud, respuesta) => {
  respuesta.sendFile(fileURLToPath(new URL("../publico/estilos/acceso.css", import.meta.url)));
});
aplicacion.get("/scripts/acceso.js", (_solicitud, respuesta) => {
  respuesta.sendFile(fileURLToPath(new URL("../publico/scripts/acceso.js", import.meta.url)));
});
aplicacion.get("/scripts/registro.js", (_solicitud, respuesta) => {
  respuesta.sendFile(fileURLToPath(new URL("../publico/scripts/registro.js", import.meta.url)));
});
aplicacion.get("/favicon.svg", (_solicitud, respuesta) => {
  respuesta.type("image/svg+xml").sendFile(
    fileURLToPath(new URL("../publico/favicon.svg", import.meta.url)),
  );
});

// Sirve recursos estáticos no confidenciales sin consultar el servicio de cuentas.
const opcionesRecursosPublicos = {
  index: false,
  etag: true,
  setHeaders(respuesta, rutaArchivo) {
    if (/\.(?:html|css|js)$/i.test(rutaArchivo)) {
      respuesta.setHeader("Cache-Control", "no-store");
    }
  },
};
for (const carpeta of ["estilos", "scripts"]) {
  aplicacion.use(
    `/${carpeta}`,
    express.static(fileURLToPath(new URL(`../publico/${carpeta}`, import.meta.url)), opcionesRecursosPublicos),
  );
}
aplicacion.get("/vendor/xterm.mjs", (_solicitud, respuesta) => {
  respuesta.type("text/javascript").sendFile(
    fileURLToPath(new URL("../node_modules/@xterm/xterm/lib/xterm.mjs", import.meta.url)),
  );
});
aplicacion.get("/vendor/xterm.css", (_solicitud, respuesta) => {
  respuesta.type("text/css").sendFile(
    fileURLToPath(new URL("../node_modules/@xterm/xterm/css/xterm.css", import.meta.url)),
  );
});
aplicacion.get("/vendor/addon-fit.mjs", (_solicitud, respuesta) => {
  respuesta.type("text/javascript").sendFile(
    fileURLToPath(new URL("../node_modules/@xterm/addon-fit/lib/addon-fit.mjs", import.meta.url)),
  );
});

// Protege la API privada, la página principal y sus operaciones.
aplicacion.use(autenticar.proteger);

async function asegurarPropietarioProyecto(solicitud, respuesta, siguiente) {
  try {
    solicitud.proyecto = await servicioProyectos.obtener(solicitud.params.id, solicitud.cuenta);
    siguiente();
  } catch (error) {
    respuesta.status(error.estadoHttp ?? 404).json({
      error: error.codigo ?? "proyecto_no_encontrado",
      mensaje: error.message,
    });
  }
}

// Devuelve métricas reales obtenidas por el backend y no por comandos del cliente.
aplicacion.get("/api/estado", async (_solicitud, respuesta) => {
  if (_solicitud.cuenta.rol !== "administrador") {
    respuesta.status(403).json({ error: "permiso_insuficiente" });
    return;
  }
  try {
    const estado = await obtenerEstadoSistema();
    respuesta.json({
      momento: estado.momento,
      cpu: estado.cpu,
      memoria: estado.memoria,
      disco: estado.disco,
      docker: estado.docker,
      mantenimiento: estado.mantenimiento,
    });
  } catch (error) {
    console.error("No se pudo leer el estado del host:", error.message);
    respuesta.status(503).json({
      error: "estado_host_no_disponible",
      mensaje: "El agente de métricas del servidor no está disponible.",
    });
  }
});

// Ejecuta solo acciones allowlisted en un contenedor cuyo nombre se confirma.
aplicacion.post(
  "/api/docker/contenedores/:id/accion",
  autenticar.mismoOrigen,
  async (solicitud, respuesta) => {
    if (solicitud.cuenta.rol !== "administrador") {
      respuesta.status(403).json({ error: "permiso_insuficiente" });
      return;
    }
    try {
      const resultado = await servicioDocker.ejecutarAccion({
        id: solicitud.params.id,
        accion: solicitud.body?.accion,
        nombreConfirmado: solicitud.body?.nombreConfirmado,
      });
      if (!resultado.correcto) {
        respuesta.status(400).json({
          error: resultado.codigo ?? "accion_rechazada",
          mensaje: resultado.mensaje ?? "No se pudo completar la acción.",
        });
        return;
      }
      console.info(`Usuario ${solicitud.usuario} ejecutó ${resultado.accion} sobre ${resultado.nombre}.`);
      respuesta.json({ correcto: true, mensaje: `Acción completada: ${resultado.accion} ${resultado.nombre}.` });
    } catch (error) {
      console.error("No se pudo completar la acción Docker:", error.message);
      respuesta.status(503).json({
        error: "agente_docker_no_disponible",
        mensaje: "El agente Docker no está disponible; no se aplicó ninguna acción.",
      });
    }
  },
);

// Expone metadatos importados y protegidos por la sesión del administrador.
aplicacion.get("/api/proyectos", async (solicitud, respuesta) => {
  try {
    const proyectos = await servicioProyectos.listar(solicitud.cuenta);
    let estadosPhp = [];
    try {
      estadosPhp = await servicioDocker.consultarRuntime();
    } catch (error) {
      console.error("No se pudo consultar el estado de runtime de los proyectos:", error.message);
    }
    const estados = new Map(estadosPhp.map((proyecto) => [proyecto.id, proyecto]));
    respuesta.json({
      proyectos: proyectos.map((proyecto) => {
        const estadoPhp = estados.get(proyecto.id);
        if (proyecto.estado !== "desplegado") return proyecto;
        return {
          ...proyecto,
          estadoRuntime: estadoPhp?.estado ?? "no_disponible",
          urlPrivada: estadoPhp?.urlPrivada ?? null,
          rutaInicio: estadoPhp?.rutaInicio ?? proyecto.rutaInicio ?? "",
          rutaProyecto: estadoPhp?.rutaProyecto ?? null,
          rutaRuntime: estadoPhp?.rutaRuntime ?? null,
          ...(estadoPhp?.rutaDatos ? { baseDatos: { ...proyecto.baseDatos, rutaDatos: estadoPhp.rutaDatos } } : {}),
        };
      }),
    });
  } catch (error) {
    console.error("No se pudo leer el registro de proyectos:", error.message);
    respuesta.status(503).json({
      error: "registro_proyectos_no_disponible",
      mensaje: "No se pudo consultar el registro de proyectos.",
    });
  }
});

// Permite leer como texto un archivo Compose enumerado en un proyecto importado.
aplicacion.get(
  "/api/proyectos/:id/compose/:archivo",
  asegurarPropietarioProyecto,
  async (solicitud, respuesta) => {
    try {
      respuesta.json(await servicioProyectos.leerCompose(
        solicitud.params.id,
        solicitud.params.archivo,
        solicitud.cuenta,
      ));
    } catch (error) {
      if (error.estadoHttp) {
        respuesta.status(error.estadoHttp).json({ error: error.codigo, mensaje: error.message });
        return;
      }
      console.error("No se pudo leer el archivo Compose para revisión:", error.message);
      respuesta.status(503).json({
        error: "archivo_compose_no_disponible",
        mensaje: "No se pudo leer el archivo Compose solicitado.",
      });
    }
  },
);

aplicacion.get(
  "/api/proyectos/:id/archivos",
  asegurarPropietarioProyecto,
  async (solicitud, respuesta) => {
    try {
      const elementos = await servicioProyectos.listarArchivos(
        solicitud.params.id,
        solicitud.query.ruta ?? "",
        solicitud.cuenta,
      );
      respuesta.json({ elementos });
    } catch (error) {
      respuesta.status(error.estadoHttp ?? 503).json({
        error: error.codigo ?? "archivos_no_disponibles",
        mensaje: error.message,
      });
    }
  },
);

aplicacion.get(
  "/api/proyectos/:id/archivo",
  asegurarPropietarioProyecto,
  async (solicitud, respuesta) => {
    try {
      respuesta.set("Cache-Control", "no-store");
      respuesta.json(await servicioProyectos.leerArchivo(
        solicitud.params.id,
        solicitud.query.ruta,
        solicitud.cuenta,
      ));
    } catch (error) {
      respuesta.status(error.estadoHttp ?? 503).json({
        error: error.codigo ?? "archivo_no_disponible",
        mensaje: error.message,
      });
    }
  },
);

aplicacion.put(
  "/api/proyectos/:id/archivo",
  autenticar.mismoOrigen,
  asegurarPropietarioProyecto,
  async (solicitud, respuesta) => {
    try {
      respuesta.json(await servicioProyectos.guardarArchivo(
        solicitud.params.id,
        solicitud.body?.ruta,
        solicitud.body?.contenido,
        solicitud.cuenta,
        solicitud.body?.contenidoBase64,
      ));
    } catch (error) {
      respuesta.status(error.estadoHttp ?? 503).json({
        error: error.codigo ?? "archivo_no_guardado",
        mensaje: error.message,
      });
    }
  },
);

aplicacion.post(
  "/api/proyectos/:id/directorios",
  autenticar.mismoOrigen,
  asegurarPropietarioProyecto,
  async (solicitud, respuesta) => {
    try {
      respuesta.status(201).json(await servicioProyectos.crearDirectorio(
        solicitud.params.id,
        solicitud.body?.ruta,
        solicitud.cuenta,
      ));
    } catch (error) {
      respuesta.status(error.estadoHttp ?? 503).json({
        error: error.codigo ?? "directorio_no_creado",
        mensaje: error.message,
      });
    }
  },
);

aplicacion.delete(
  "/api/proyectos/:id/archivo",
  autenticar.mismoOrigen,
  asegurarPropietarioProyecto,
  async (solicitud, respuesta) => {
    try {
      respuesta.json(await servicioProyectos.eliminarArchivo(
        solicitud.params.id,
        solicitud.body?.ruta,
        solicitud.cuenta,
      ));
    } catch (error) {
      respuesta.status(error.estadoHttp ?? 503).json({
        error: error.codigo ?? "archivo_no_eliminado",
        mensaje: error.message,
      });
    }
  },
);

aplicacion.post(
  "/api/proyectos/:id/consola",
  autenticar.mismoOrigen,
  asegurarPropietarioProyecto,
  async (solicitud, respuesta) => {
    try {
      const resultado = await servicioDocker.ejecutarConsola({
        id: solicitud.params.id,
        nombreConfirmado: solicitud.proyecto.nombre,
        comando: solicitud.body?.comando,
        directorio: solicitud.body?.directorio,
      });
      if (!resultado.correcto) {
        respuesta.status(400).json({
          error: resultado.codigo ?? "consola_rechazada",
          mensaje: resultado.mensaje ?? "No se pudo ejecutar el comando.",
        });
        return;
      }
      respuesta.set("Cache-Control", "no-store");
      respuesta.json(resultado);
    } catch (error) {
      console.error("No se pudo ejecutar la consola del proyecto:", error.message);
      respuesta.status(503).json({
        error: "consola_no_disponible",
        mensaje: "No se pudo iniciar la consola aislada.",
      });
    }
  },
);

// Descarga repositorios HTTPS públicos sin ejecutar código ni archivos Compose.
aplicacion.post("/api/proyectos", autenticar.mismoOrigen, async (solicitud, respuesta) => {
  try {
    const proyecto = await servicioProyectos.importar(solicitud.body, solicitud.cuenta.id);
    console.info(`Usuario ${solicitud.usuario} importó el proyecto ${proyecto.nombre} para revisión.`);
    respuesta.status(201).json({ proyecto });
  } catch (error) {
    if (error.estadoHttp) {
      respuesta.status(error.estadoHttp).json({ error: error.codigo, mensaje: error.message });
      return;
    }
    console.error("No se pudo importar un proyecto:", error.cause?.message ?? error.message);
    respuesta.status(502).json({
      error: "importacion_no_disponible",
      mensaje: error.message,
    });
  }
});

// Despliega un perfil fijo administrado, sin ejecutar Dockerfiles ni Compose importados.
aplicacion.post(
  "/api/proyectos/:id/desplegar",
  autenticar.mismoOrigen,
  asegurarPropietarioProyecto,
  async (solicitud, respuesta) => {
    try {
      const resultado = await servicioDocker.desplegarAplicacion({
        id: solicitud.params.id,
        perfil: solicitud.body?.perfil,
        nombreConfirmado: solicitud.body?.nombreConfirmado,
      });
      if (!resultado.correcto) {
        respuesta.status(400).json({
          error: resultado.codigo ?? "despliegue_rechazado",
          mensaje: resultado.mensaje ?? "No se pudo desplegar el proyecto.",
        });
        return;
      }
      console.info(`Usuario ${solicitud.usuario} desplegó ${resultado.nombre} con perfil ${resultado.perfil} en localhost:${resultado.puerto}.`);
      respuesta.json({
        correcto: true,
        perfil: resultado.perfil,
        nombre: resultado.nombre,
        puerto: resultado.puerto,
        mensaje: preparado.recrear === true
          ? "El runtime PHP antiguo se recreó y ya incluye el montaje seguro para futuras conexiones de base de datos."
          : `${resultado.perfil} quedó desplegado correctamente.`,
      });
    } catch (error) {
      console.error("No se pudo desplegar la aplicación:", error.message);
      respuesta.status(503).json({
        error: "agente_runtime_no_disponible",
        mensaje: mensajeAgenteNoDisponible(error, "el despliegue"),
      });
    }
  },
);

aplicacion.post(
  "/api/proyectos/:id/actualizar",
  autenticar.mismoOrigen,
  asegurarPropietarioProyecto,
  async (solicitud, respuesta) => {
    try {
      const { id } = solicitud.params;
      const nombreConfirmado = solicitud.proyecto.nombre;
      if (solicitud.body?.nombreConfirmado !== nombreConfirmado) {
        respuesta.status(400).json({
          error: "confirmacion_invalida",
          mensaje: "Escribe el nombre exacto del proyecto para confirmar la actualización.",
        });
        return;
      }
      const preparado = await servicioDocker.prepararActualizacion({ id, nombreConfirmado });
      if (!preparado.correcto) {
        respuesta.status(400).json({
          error: preparado.codigo ?? "actualizacion_rechazada",
          mensaje: preparado.mensaje ?? "No se pudo preparar la actualización.",
        });
        return;
      }
      if (preparado.perfil === "php" && preparado.recrear !== true) {
        respuesta.json({
          correcto: true,
          mensaje: "Los archivos PHP guardados ya están aplicados y el servicio se reinició.",
        });
        return;
      }
      const resultado = await servicioDocker.desplegarAplicacion({
        id,
        perfil: preparado.perfil,
        nombreConfirmado,
      });
      if (!resultado.correcto) {
        respuesta.status(400).json({
          error: resultado.codigo ?? "actualizacion_no_completada",
          mensaje: `El runtime anterior se retiró, pero no se pudo desplegar la nueva versión: ${resultado.mensaje ?? "revisa los archivos del proyecto"}`,
        });
        return;
      }
      respuesta.json({
        correcto: true,
        perfil: resultado.perfil,
        puerto: resultado.puerto,
        mensaje: "El proyecto se recompiló y actualizó correctamente.",
      });
    } catch (error) {
      console.error("No se pudo actualizar el proyecto:", error.message);
      respuesta.status(503).json({
        error: "actualizacion_no_disponible",
        mensaje: mensajeAgenteNoDisponible(error, "la actualización"),
      });
    }
  },
);

// Mantiene el endpoint de despliegue PHP para clientes anteriores.
aplicacion.post(
  "/api/proyectos/:id/desplegar-php",
  autenticar.mismoOrigen,
  asegurarPropietarioProyecto,
  async (solicitud, respuesta) => {
    try {
      const resultado = await servicioDocker.desplegarPhp({
        id: solicitud.params.id,
        nombreConfirmado: solicitud.body?.nombreConfirmado,
      });
      if (!resultado.correcto) {
        respuesta.status(400).json({
          error: resultado.codigo ?? "despliegue_rechazado",
          mensaje: resultado.mensaje ?? "No se pudo desplegar el proyecto.",
        });
        return;
      }
      console.info(`Usuario ${solicitud.usuario} desplegó ${resultado.nombre} en el puerto local ${resultado.puerto}.`);
      respuesta.json({
        correcto: true,
        nombre: resultado.nombre,
        puerto: resultado.puerto,
        mensaje: "PHP/Apache quedó desplegado correctamente.",
      });
    } catch (error) {
      console.error("No se pudo desplegar el proyecto PHP:", error.message);
      respuesta.status(503).json({
        error: "agente_docker_no_disponible",
        mensaje: "El agente no pudo completar el despliegue PHP.",
      });
    }
  },
);

// Controla un runtime administrado y confirma el nombre exacto del proyecto.
aplicacion.post(
  "/api/proyectos/:id/accion-runtime",
  autenticar.mismoOrigen,
  asegurarPropietarioProyecto,
  async (solicitud, respuesta) => {
    try {
      const resultado = await servicioDocker.operarRuntime({
        id: solicitud.params.id,
        accion: solicitud.body?.accion,
        nombreConfirmado: solicitud.body?.nombreConfirmado,
      });
      if (!resultado.correcto) {
        respuesta.status(400).json({
          error: resultado.codigo ?? "accion_php_rechazada",
          mensaje: resultado.mensaje ?? "No se pudo completar la acción del proyecto.",
        });
        return;
      }
      console.info(`Usuario ${solicitud.usuario} ejecutó ${solicitud.body.accion} para ${resultado.nombre}.`);
      respuesta.json({
        correcto: true,
        nombre: resultado.nombre,
        estado: resultado.estado,
        puerto: resultado.puerto,
        mensaje: `Proyecto ${resultado.nombre}: ${resultado.estado}.`,
      });
    } catch (error) {
      console.error("No se pudo controlar el runtime:", error.message);
      respuesta.status(503).json({
        error: "agente_php_no_disponible",
        mensaje: "El agente no pudo completar la acción del proyecto.",
      });
    }
  },
);

// Crea una base de datos fija y entrega la credencial solo en esta respuesta.
aplicacion.post(
  "/api/proyectos/:id/base-datos",
  autenticar.mismoOrigen,
  asegurarPropietarioProyecto,
  async (solicitud, respuesta) => {
    try {
      const resultado = await servicioDocker.crearBaseDatos({
        id: solicitud.params.id,
        motor: solicitud.body?.motor,
        nombreBaseDatos: solicitud.body?.nombreBaseDatos,
        nombreConfirmado: solicitud.body?.nombreConfirmado,
      });
      if (!resultado.correcto) {
        respuesta.status(400).json({
          error: resultado.codigo ?? "base_datos_rechazada",
          mensaje: resultado.mensaje ?? "No se pudo crear la base de datos.",
        });
        return;
      }
      console.info(`Usuario ${solicitud.usuario} creó una base ${resultado.motor} para ${solicitud.body.nombreConfirmado}.`);
      respuesta.set("Cache-Control", "no-store");
      respuesta.json({
        correcto: true,
        motor: resultado.motor,
        host: resultado.host,
        puerto: resultado.puerto,
        nombre: resultado.nombre,
        usuario: resultado.usuario,
        contrasena: resultado.contrasena,
        rutaDatos: resultado.rutaDatos,
        mensaje: "La contraseña quedó protegida en el servidor y puede consultarse de nuevo con confirmación.",
      });
    } catch (error) {
      console.error("No se pudo crear la base de datos:", error.message);
      respuesta.status(503).json({
        error: "agente_base_datos_no_disponible",
        mensaje: "El agente no pudo completar la creación de la base de datos.",
      });
    }
  },
);

// Revela la credencial persistente solo tras otra confirmación explícita.
aplicacion.post(
  "/api/proyectos/:id/base-datos/credenciales",
  autenticar.mismoOrigen,
  asegurarPropietarioProyecto,
  async (solicitud, respuesta) => {
    try {
      const resultado = await servicioDocker.consultarCredencialesBaseDatos({
        id: solicitud.params.id,
        motor: solicitud.body?.motor,
        nombreBaseDatos: solicitud.body?.nombreBaseDatos,
        nombreConfirmado: solicitud.body?.nombreConfirmado,
      });
      if (!resultado.correcto) {
        respuesta.status(400).json({
          error: resultado.codigo ?? "credenciales_base_datos_rechazadas",
          mensaje: resultado.mensaje ?? "No se pudieron consultar las credenciales.",
        });
        return;
      }
      console.info(`Usuario ${solicitud.usuario} consultó credenciales de ${resultado.motor} para ${solicitud.body.nombreConfirmado}.`);
      respuesta.set("Cache-Control", "no-store");
      respuesta.json({
        correcto: true,
        motor: resultado.motor,
        host: resultado.host,
        puerto: resultado.puerto,
        nombre: resultado.nombre,
        usuario: resultado.usuario,
        contrasena: resultado.contrasena,
        rutaDatos: resultado.rutaDatos,
      });
    } catch (error) {
      console.error("No se pudieron consultar credenciales de base de datos:", error.message);
      respuesta.status(503).json({
        error: "agente_base_datos_no_disponible",
        mensaje: "El agente no pudo consultar las credenciales protegidas.",
      });
    }
  },
);

// Elimina el código y el runtime; archiva los metadatos si se conserva una base.
aplicacion.delete(
  "/api/proyectos/:id",
  autenticar.mismoOrigen,
  asegurarPropietarioProyecto,
  async (solicitud, respuesta) => {
    try {
      const { id } = solicitud.params;
      if (solicitud.body?.nombreConfirmado !== solicitud.proyecto.nombre) {
        respuesta.status(400).json({
          error: "confirmacion_invalida",
          mensaje: "Escribe el nombre exacto del proyecto para confirmar su eliminación.",
        });
        return;
      }
      const nombreConfirmado = solicitud.proyecto.nombre;
      const archivado = await servicioDocker.archivarProyecto({ id, nombreConfirmado });
      if (!archivado.correcto) {
        respuesta.status(400).json({
          error: archivado.codigo ?? "archivo_rechazado",
          mensaje: archivado.mensaje ?? "No se pudo preparar el borrado del proyecto.",
        });
        return;
      }
      const resultado = await servicioProyectos.eliminarProyecto(id, solicitud.cuenta);
      console.info(`Usuario ${solicitud.usuario} eliminó el código del proyecto ${resultado.proyecto}; base conservada: ${resultado.baseDatosConservada}.`);
      respuesta.json({
        correcto: true,
        baseDatosConservada: resultado.baseDatosConservada,
        mensaje: resultado.baseDatosConservada
          ? "Se eliminó el código y el runtime. La base permanece archivada hasta que la elimines por separado."
          : "Se eliminó el proyecto y su runtime.",
      });
    } catch (error) {
      console.error("No se pudo eliminar el proyecto:", error.message);
      if (error.estadoHttp) {
        respuesta.status(error.estadoHttp).json({
          error: error.codigo ?? "eliminacion_proyecto_rechazada",
          mensaje: error.message,
        });
        return;
      }
      respuesta.status(503).json({
        error: "eliminacion_proyecto_no_disponible",
        mensaje: "No se pudo completar la eliminación del proyecto.",
      });
    }
  },
);

// La eliminación de la base es una operación aparte y requiere confirmación exacta.
aplicacion.delete(
  "/api/proyectos/:id/base-datos",
  autenticar.mismoOrigen,
  asegurarPropietarioProyecto,
  async (solicitud, respuesta) => {
    try {
      const { id } = solicitud.params;
      if (solicitud.body?.nombreConfirmado !== solicitud.proyecto.nombre) {
        respuesta.status(400).json({
          error: "confirmacion_invalida",
          mensaje: "Escribe el nombre exacto del proyecto para confirmar la eliminación de su base.",
        });
        return;
      }
      if (solicitud.proyecto.estado !== "archivado" || !solicitud.proyecto.baseDatos) {
        respuesta.status(409).json({
          error: "base_no_archivada",
          mensaje: "Archiva el proyecto antes de eliminar su base de datos.",
        });
        return;
      }
      const resultado = await servicioDocker.eliminarBaseDatos({
        id,
        motor: solicitud.proyecto.baseDatos.motor,
        nombreBaseDatos: solicitud.proyecto.baseDatos.nombre,
        nombreConfirmado: solicitud.proyecto.nombre,
      });
      if (!resultado.correcto) {
        respuesta.status(400).json({
          error: resultado.codigo ?? "eliminacion_base_datos_rechazada",
          mensaje: resultado.mensaje ?? "No se pudo eliminar la base de datos.",
        });
        return;
      }
      await servicioProyectos.eliminarBaseArchivada(id, solicitud.cuenta);
      console.info(`Usuario ${solicitud.usuario} eliminó la base archivada del proyecto ${resultado.nombre}.`);
      respuesta.json({ correcto: true, mensaje: "Se eliminaron el servicio, el volumen y las credenciales de la base archivada." });
    } catch (error) {
      console.error("No se pudo eliminar la base de datos:", error.message);
      if (error.estadoHttp) {
        respuesta.status(error.estadoHttp).json({
          error: error.codigo ?? "eliminacion_base_datos_rechazada",
          mensaje: error.message,
        });
        return;
      }
      respuesta.status(503).json({
        error: "eliminacion_base_datos_no_disponible",
        mensaje: "No se pudo completar la eliminación de la base de datos.",
      });
    }
  },
);

// Entrega la pantalla principal únicamente a administradores autenticados.
aplicacion.get("/", (_solicitud, respuesta) => {
  respuesta.set("Cache-Control", "no-store");
  respuesta.sendFile(fileURLToPath(new URL("../publico/index.html", import.meta.url)));
});

// Inicia el servidor en todas las interfaces del contenedor.
const servidorHttp = aplicacion.listen(entorno.puerto, "0.0.0.0", () => {
  console.log(`Panel preparado en el puerto ${entorno.puerto}.`);
});

const servidorWebSocket = new WebSocketServer({
  noServer: true,
  maxPayload: 65_536,
  perMessageDeflate: false,
});
const sesionesTerminalPorUsuario = new Map();

function rechazarActualizacionTerminal(socket, estado, mensaje) {
  socket.write(
    `HTTP/1.1 ${estado} ${mensaje}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

servidorHttp.on("upgrade", async (solicitud, conexion, cabeceras) => {
  let terminalAbierta = false;
  let idCuentaTerminal;
  try {
    const origen = solicitud.headers.origin;
    const protocolo = solicitud.headers["x-forwarded-proto"]?.split(",")[0]?.trim() ?? "http";
    const origenEsperado = `${protocolo}://${solicitud.headers.host}`;
    if (typeof origen !== "string" || origen !== origenEsperado) {
      rechazarActualizacionTerminal(conexion, 403, "Forbidden");
      return;
    }
    const sesion = await autenticar.obtenerSesion(solicitud);
    if (!sesion) {
      rechazarActualizacionTerminal(conexion, 401, "Unauthorized");
      return;
    }
    const url = new URL(solicitud.url ?? "/", origenEsperado);
    const coincidencia = url.pathname.match(/^\/api\/proyectos\/([a-f0-9-]{36})\/terminal$/i);
    if (!coincidencia) {
      rechazarActualizacionTerminal(conexion, 404, "Not Found");
      return;
    }
    const proyecto = await servicioProyectos.obtener(coincidencia[1], sesion);
    const sesionesUsuario = sesionesTerminalPorUsuario.get(sesion.id) ?? 0;
    if (sesionesUsuario >= 2 || sesionesTerminalPorUsuario.size >= 8) {
      rechazarActualizacionTerminal(conexion, 429, "Too Many Requests");
      return;
    }
    idCuentaTerminal = sesion.id;
    sesionesTerminalPorUsuario.set(sesion.id, sesionesUsuario + 1);
    terminalAbierta = true;

    servidorWebSocket.handleUpgrade(solicitud, conexion, cabeceras, (webSocket) => {
      servidorWebSocket.emit("connection", webSocket, solicitud);
      let conexionAgente;
      let cerrado = false;
      let conexionViva = true;
      const revisarSesion = setInterval(() => {
        void autenticar.obtenerSesion(solicitud).then((sesionActual) => {
          if (!sesionActual) webSocket.close(1008, "La sesión expiró");
        }).catch(() => {
          webSocket.close(1011, "No se pudo comprobar la sesión");
        });
      }, 30_000);
      revisarSesion.unref();
      const revisarConexion = setInterval(() => {
        if (!conexionViva) {
          webSocket.terminate();
          return;
        }
        conexionViva = false;
        webSocket.ping();
      }, 30_000);
      revisarConexion.unref();
      const liberarSesion = () => {
        if (cerrado) return;
        cerrado = true;
        clearInterval(revisarSesion);
        clearInterval(revisarConexion);
        const restantes = (sesionesTerminalPorUsuario.get(sesion.id) ?? 1) - 1;
        if (restantes > 0) sesionesTerminalPorUsuario.set(sesion.id, restantes);
        else sesionesTerminalPorUsuario.delete(sesion.id);
        conexionAgente?.destroy();
      };
      webSocket.once("close", liberarSesion);
      webSocket.once("error", liberarSesion);
      webSocket.on("pong", () => {
        conexionViva = true;
      });
      webSocket.send(JSON.stringify({ tipo: "estado", mensaje: "Preparando el entorno aislado..." }));

      const columnas = Number(url.searchParams.get("columnas") ?? 100);
      const filas = Number(url.searchParams.get("filas") ?? 30);
      void servicioDocker.abrirTerminal({
        id: proyecto.id,
        nombreConfirmado: proyecto.nombre,
        directorio: url.searchParams.get("directorio") ?? ".",
        columnas,
        filas,
      }).then(({ conexion: socketAgente, datosIniciales, directorio }) => {
        conexionAgente = socketAgente;
        if (webSocket.readyState !== WebSocket.OPEN) {
          liberarSesion();
          return;
        }
        webSocket.send(JSON.stringify({ tipo: "lista", directorio }));
        if (datosIniciales.length) webSocket.send(datosIniciales, { binary: true });
        socketAgente.on("data", (fragmento) => {
          if (webSocket.readyState !== WebSocket.OPEN) return;
          if (webSocket.bufferedAmount > 1_048_576) {
            webSocket.close(1013, "El cliente no recibe la salida a tiempo");
            liberarSesion();
            return;
          }
          webSocket.send(fragmento, { binary: true });
        });
        socketAgente.once("close", () => {
          if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1011, "La terminal finalizó");
          liberarSesion();
        });
        socketAgente.once("error", (error) => {
          console.error("Se perdió la conexión con una terminal:", error.message);
          if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1011, "Conexión con el agente interrumpida");
          liberarSesion();
        });
        webSocket.on("message", (datos, esBinario) => {
          if (!conexionAgente || conexionAgente.destroyed) return;
          if (esBinario) {
            if (datos.length > 65_536) {
              webSocket.close(1009, "Entrada demasiado grande");
              liberarSesion();
              return;
            }
            const marco = Buffer.allocUnsafe(5 + datos.length);
            marco.writeUInt8(1, 0);
            marco.writeUInt32BE(datos.length, 1);
            datos.copy(marco, 5);
            conexionAgente.write(marco);
            return;
          }
          try {
            const mensaje = JSON.parse(datos.toString("utf8"));
            if (
              mensaje.tipo === "redimensionar"
              && Number.isInteger(mensaje.columnas)
              && Number.isInteger(mensaje.filas)
              && mensaje.columnas >= 20
              && mensaje.columnas <= 300
              && mensaje.filas >= 5
              && mensaje.filas <= 100
            ) {
              const marco = Buffer.alloc(9);
              marco.writeUInt8(2, 0);
              marco.writeUInt32BE(4, 1);
              marco.writeUInt16BE(mensaje.columnas, 5);
              marco.writeUInt16BE(mensaje.filas, 7);
              conexionAgente.write(marco);
            }
          } catch {
            webSocket.close(1003, "Mensaje de control inválido");
            liberarSesion();
          }
        });
        socketAgente.resume();
      }).catch((error) => {
        if (webSocket.readyState === WebSocket.OPEN) {
          const mensaje = error.code === "ECONNREFUSED" || error.code === "ENOENT"
            ? mensajeAgenteNoDisponible(error, "la terminal")
            : error.message;
          webSocket.send(JSON.stringify({ tipo: "error", mensaje }));
          webSocket.close(1011, "No se pudo iniciar la terminal");
        }
        liberarSesion();
      });
    });
  } catch (error) {
    if (terminalAbierta && idCuentaTerminal) {
      const restantes = (sesionesTerminalPorUsuario.get(idCuentaTerminal) ?? 1) - 1;
      if (restantes > 0) sesionesTerminalPorUsuario.set(idCuentaTerminal, restantes);
      else sesionesTerminalPorUsuario.delete(idCuentaTerminal);
    }
    const estado = error.estadoHttp ?? 500;
    rechazarActualizacionTerminal(conexion, estado, estado === 404 ? "Not Found" : "Internal Server Error");
  }
});
