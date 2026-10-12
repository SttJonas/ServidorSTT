# Panel de aplicaciones para Debian

Panel web de administración y autoalojado para importar repositorios públicos,
revisar proyectos, desplegar aplicaciones con perfiles administrados y
gestionar bases de datos. Esta guía empieza desde la instalación de Debian y
cubre la red, Docker, las cuentas, el agente, el panel, el acceso remoto, las
copias de seguridad y la resolución de problemas. Elige el usuario
administrador, la cuenta de servicio, el nombre de host, el dominio y las
carpetas según tu instalación. Los valores de ejemplo son genéricos y se deben
reemplazar por los propios.

El código fuente de este repositorio puede consultarse, descargarse, clonarse,
copiarse y modificarse libremente de acuerdo con la licencia del proyecto. Las
siguientes advertencias se refieren a ejecutar una instancia del panel y
conceder acceso al servidor, no a quién puede obtener el código.

> [!IMPORTANT]
> Una instancia desplegada permite ejecutar dependencias y código de los
> proyectos durante las compilaciones y ofrece una terminal Bash a las cuentas
> a las que el administrador invita. Invitar a una cuenta concede acceso a esas
> funciones en el servidor; hazlo solo si deseas otorgar ese acceso. Docker limita
> los contenedores, pero comparte el kernel del host y no es una frontera de
> seguridad suficiente para ejecutar código malicioso. Esta es una advertencia
> sobre la operación de una instancia, no una restricción para descargar, clonar
> o contribuir al repositorio.

## Funciones

- Autenticación, perfiles personales, sesiones y cuentas almacenadas de forma
  persistente. No hay registro abierto: un administrador crea invitaciones
  individuales que expiran a las 24 horas y se usan una sola vez.
- Roles de administrador y operador. Los operadores solo gestionan los
  proyectos que importaron; los administradores gestionan todos los proyectos,
  usuarios, métricas y contenedores.
- Importación de ramas de repositorios públicos HTTPS de GitHub y GitLab.
  Importar un repositorio no lo ejecuta ni despliega.
- Revisión de archivos Compose detectados. El panel nunca ejecuta un Compose ni
  un Dockerfile importado.
- Despliegues con imágenes y comandos fijados por perfiles administrados.
- PostgreSQL, MariaDB, MongoDB y Redis con almacenamiento persistente y acceso
  privado dentro de la red de cada proyecto.
- Terminal Bash interactiva y explorador/editor de archivos en secciones
  distintas. La terminal se limita al proyecto seleccionado.
- Lectura de métricas del host mediante un agente Python y socket Unix. El
  contenedor web no monta el socket de administración de Docker.

Los límites actuales incluyen 25 proyectos importados, repositorios de hasta
256 MiB y 25 000 archivos, cuatro aplicaciones desplegadas y cuatro bases de
datos administradas. El editor admite archivos de hasta 1 MiB y muestra hasta
500 elementos por directorio. Los archivos Compose se limitan a 256 KiB por
archivo; las peticiones JSON del panel tienen un límite de 2 MiB. Son límites
del software, no recomendaciones de capacidad del hardware.

## Arquitectura

```text
Navegador
  └─ HTML, CSS, JavaScript y xterm.js
       │ HTTP(S), API JSON y WebSocket
       ▼
Panel Node.js + Express ─────── servicio PHP + SQLite persistente
       │ socket Unix
       ▼
Agente Python ──────────────── Docker Engine
                                  ├─ compiladores temporales
                                  ├─ aplicaciones administradas
                                  ├─ bases de datos por proyecto
                                  └─ terminales Bash temporales
```

Docker Compose publica el panel solo en `127.0.0.1` por defecto. Un proxy HTTPS
separado —por ejemplo, Tailscale Serve dentro de una tailnet privada— puede
reenviar solicitudes HTTP y WebSocket a ese puerto. Las aplicaciones alojadas
no reciben automáticamente un dominio público: configurar el proxy para
publicarlas es una tarea aparte.

#### Por qué se separan los componentes

- **Interfaz y API en Node.js:** HTML, CSS y JavaScript renderizan el panel; Node
  gestiona las rutas HTTP, autenticación de solicitudes y WebSocket de terminal.
- **Cuentas en PHP y SQLite:** PHP real atiende las operaciones de cuentas con
  PDO, consultas preparadas, hashes de contraseñas y tokens de sesión. SQLite
  persiste en un volumen y el servicio no publica un puerto al host.
- **Operaciones del host en Python:** un agente systemd acotado consulta
  métricas y valida una lista permitida de acciones Docker. Node se comunica
  con él mediante socket Unix; el contenedor web no monta `docker.sock`.
- **Ejecución administrada en Docker:** cada perfil usa imágenes y comandos
  controlados, redes privadas y límites de recursos. No se ejecutan los
  Dockerfile ni Compose importados. Los scripts y dependencias de una
  compilación sí provienen del repositorio y deben revisarse antes de confiar
  en ellos.
- **Acceso HTTPS por separado:** Compose enlaza el panel a loopback para que
  un proxy elegido por el administrador gestione TLS y publicación. Un túnel
  SSH sirve para pruebas puntuales sin abrir los puertos de las aplicaciones.

### Árbol del proyecto

```text
.
├── agente/monitor_host.py             # Agente Python del host y operaciones Docker acotadas
├── configuracion/entorno.js           # Carga y validación de configuración del panel
├── despliegue/swatt-monitor.service   # Unidad systemd de ejemplo para el agente
├── scripts/configurar-acceso.js       # Crea la configuración privada y el hash inicial
├── php-cuentas/
│   ├── Dockerfile                     # Servicio PHP 8.3 + Apache, con PDO SQLite
│   ├── index.php                      # API interna de cuentas y persistencia
│   ├── php.ini                        # Límites y opciones seguras de PHP
│   └── pruebas/                       # Pruebas de integración PHP/SQLite
├── src/
│   ├── servidor.js                    # API, autenticación, archivos y WebSocket
│   └── servicios/                     # Autenticación, usuarios, proyectos, Docker y métricas
├── publico/
│   ├── index.html                     # Interfaz autenticada
│   ├── acceso.html                    # Inicio de sesión
│   ├── registro.html                  # Aceptación de invitaciones
│   ├── scripts/panel.js               # Navegación, API y terminal web
│   └── estilos/                       # Hojas de estilo de cada sección
├── tests/                             # Pruebas de Node.js y Python
├── proyectos/.gitkeep                 # Raíz local vacía para proyectos importados
├── Dockerfile                         # Imagen del panel Node.js
├── docker-compose.yml                 # Servicio, puertos, volúmenes y grupo Docker
├── package.json                       # Dependencias y comandos npm
├── package-lock.json                  # Versiones resueltas para npm ci
├── .env.example                       # Plantilla sin secretos
├── .gitignore                         # Excluye datos locales y credenciales
└── README.md
```

Los nombres internos `swatt-monitor`, `/run/swatt-monitor` y
`/var/lib/swatt-monitor` se usan en la unidad systemd, el agente y el panel.
Puedes cambiar el usuario, nombre de host, dominio y rutas de proyectos, pero
si cambias esos nombres internos también debes actualizar las rutas
correspondientes en el código, la unidad y Compose.

### Equipo de referencia y capacidad

La configuración original se diseñó para un equipo tipo portátil antiguo
reutilizado como servidor sin monitor, con Debian 13 de 64 bits, alrededor de
8 GiB de RAM y una unidad interna de aproximadamente 108 GB. Son cifras de
referencia, no requisitos mínimos ni una detección automática: anota los datos
reales de tu equipo durante la instalación. CPU, memoria, almacenamiento,
temperatura, refrigeración y conexión de red condicionan cuántas compilaciones,
aplicaciones y bases de datos se pueden ejecutar simultáneamente. El panel
limita cada servicio, pero no puede compensar recursos insuficientes en el host.

| Área | Configuración de referencia | Qué debe configurar cada administrador |
| --- | --- | --- |
| Sistema | Debian 13, 64 bits, arquitectura x86-64; la instalación original usó la rama Testing | Para una instalación nueva se recomienda Debian Stable; elige hostname, zona horaria, actualizaciones y cuenta personal |
| Red | Wi-Fi o Ethernet, IPv4 privada en una subred local; NetworkManager/`nmcli` puede gestionar Wi-Fi | Interfaz, DHCP o reserva en el router, DNS y acceso remoto |
| Seguridad de host | SSH con acceso `root` deshabilitado, UFW activo; el muestreo de referencia permitía SSH `22/tcp` y HTTP `80/tcp`; Fail2ban con jail `sshd` | Usuario, puerto SSH y reglas que realmente necesita la red |
| Contenedores | Docker Engine, Compose v2 y puente administrado por Docker | Instalar desde el repositorio oficial de Docker; no fijar a mano el rango del puente |
| CPU | El panel identificó 2 núcleos lógicos; la carga observada cambia según el uso | No interpretes una lectura o porcentaje de reposo como capacidad garantizada |
| Memoria | 7724 MiB totales; una lectura inicial mostró 543 MiB usados y 7181 MiB disponibles; la muestra indicó además 6157 MiB de swap libre | Deja memoria disponible para el host, compilaciones, runtimes y bases |
| Almacenamiento | Unidad interna eMMC de aproximadamente 108 GB; una lectura inicial indicó 2 GB usados y unos 100 GB libres | Vigila el crecimiento de proyectos, cachés, imágenes Docker y volúmenes |
| Conectividad observada | Un ensayo inicial de Internet recibió 4/4 respuestas de `8.8.8.8`, con unos 259 ms de latencia media | Vuelve a probar desde tu propia red; latencia, pérdida y ancho de banda varían |
| Portátil sin monitor | La acción al cerrar la tapa está configurada como `ignore` | Aplicar la configuración de logind descrita más abajo solo si el equipo debe seguir encendido cerrado |

No copies a este README la contraseña, IP, MAC, SSID, hostname ni el nombre de
cuenta de una instalación real. Usa en su lugar los valores propios del equipo
y conserva los secretos fuera del repositorio.

## Requisitos

### Sistema operativo del servidor

Usa una instalación limpia de **Debian 13 (stable)** de 64 bits, compatible con
la arquitectura de tu equipo. Debian Stable aporta systemd, una conexión de
red y paquetes mantenidos. El servidor también necesita espacio suficiente
para imágenes Docker, dependencias de compilación y volúmenes de bases de datos.

1. Descarga una imagen desde la página oficial de
   [imágenes netinst de Debian](https://www.debian.org/CD/netinst/) o consulta
   [todas las imágenes oficiales](https://www.debian.org/distrib/) y sigue la
   [guía oficial de instalación](https://www.debian.org/releases/stable/installmanual/).
   Elige la arquitectura apropiada —por ejemplo, amd64 para x86-64— y verifica
   la imagen siguiendo las [instrucciones oficiales de integridad](https://www.debian.org/CD/verify/).
2. Durante la instalación crea una cuenta personal de administración con una
   contraseña única, configura la zona horaria y la red, e instala **OpenSSH
   Server** si administrarás el equipo remotamente. Conserva el usuario de
   administración y la dirección de red que el router asigne al equipo; son
   propios de cada instalación.
3. Instala Debian sin entorno gráfico si el equipo funcionará como servidor sin
   monitor. Conserva las tareas estándar del sistema y asegúrate de instalar
   OpenSSH Server cuando sea necesario.
4. Tras el primer inicio, actualiza los paquetes:

   ```bash
   sudo apt update
   sudo apt full-upgrade
   sudo apt install ca-certificates curl git openssh-server python3 sudo
   ```

   Si tu cuenta no tiene permisos de `sudo`, entra como `root` con `su -` e
   instala y configura `sudo`. Añade solo tu cuenta personal de administración
   al grupo `sudo` con `usermod -aG sudo USUARIO_ADMIN`; sustituye el marcador
   por el usuario que creaste durante la instalación y vuelve a iniciar sesión.

5. Antes de continuar, decide cómo recuperarás el acceso si falla la red. Si es
   posible, conserva acceso físico al equipo y prueba SSH desde otro dispositivo
   de tu red local antes de activar el firewall o cerrar la tapa.

Consulta también la [documentación de Debian](https://www.debian.org/doc/).

### Red, SSH, firewall y portátiles

#### Conexión estable

Para un servidor permanente, se recomienda Ethernet. Si solo tienes Wi-Fi,
configúralo durante la instalación y comprueba que Debian se reconecte después
de reiniciar. En el router crea una **reserva DHCP** para el equipo; así su IP
local se mantiene sin asignar manualmente una dirección que pueda colisionar
con otro dispositivo. La IP, máscara, puerta de enlace, DNS, interfaz y MAC
cambian en cada equipo. No copies aquí valores de una red real.

Si NetworkManager está instalado, conecta el servidor a una red Wi-Fi desde
la consola. Sustituye `NOMBRE_DE_TU_RED` y `TU_CONTRASEÑA` por los datos de tu
red. El último comando guarda el perfil de conexión para que NetworkManager
pueda reconectarse después de reiniciar:

```bash
sudo nmcli device wifi rescan
sudo nmcli device wifi list
sudo nmcli device wifi connect "NOMBRE_DE_TU_RED" password "TU_CONTRASEÑA"
```

Evita escribir la contraseña real en comandos que queden guardados en el
historial de la terminal. Para redes ocultas, añade `hidden yes` al comando de
conexión. Si prefieres no poner la contraseña en la línea de comandos, ejecuta
`sudo nmcli --ask device wifi connect "NOMBRE_DE_TU_RED"` y responde cuando
`nmcli` la solicite. Para usar otra interfaz inalámbrica, lista primero los
dispositivos con `nmcli device status` y agrega `ifname NOMBRE_INTERFAZ` al
comando de conexión.

Comprueba después la conexión con:

```bash
nmcli device status
ip -br address
ip route
getent hosts deb.debian.org
```

`nmcli connection show` lista los perfiles guardados. No cambies a una IP
estática sin coordinarla con el router; un error de máscara o puerta de enlace
puede dejar el servidor inaccesible. El puente `docker0` y su subred son
administrados por Docker; no se deben configurar a mano ni compartir su rango
con la LAN.

#### SSH y acceso de administración

Mantén habilitado SSH solo si lo necesitas. Entra con tu cuenta personal de
administración, no como `root`. Primero configura y prueba una clave SSH desde
otro equipo; **no deshabilites el acceso por contraseña antes de confirmar que
la clave funciona**, para evitar bloquearte fuera. Después puedes crear una
configuración local:

```bash
sudo install -d -m 0755 /etc/ssh/sshd_config.d
sudo tee /etc/ssh/sshd_config.d/10-servidor.conf >/dev/null <<'EOF'
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication no
EOF
sudo sshd -t
sudo systemctl reload ssh
```

Si necesitas mantener acceso SSH por contraseña, elimina
`PasswordAuthentication no` y usa una contraseña única y robusta. Prueba una
nueva sesión SSH antes de cerrar la que ya funciona. Si el puerto SSH no es el
22, ajusta las reglas del firewall y Fail2ban al puerto real.

#### UFW y Fail2ban

UFW aplica reglas de red y Fail2ban bloquea temporalmente direcciones que
repiten intentos fallidos de SSH. Fail2ban no sustituye contraseñas seguras ni
reglas de firewall. Antes de activar UFW, permite tu puerto SSH y verifica que
tengas acceso físico o una sesión de recuperación:

```bash
sudo apt install ufw fail2ban
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'SSH'
sudo ufw status numbered
sudo ufw enable
sudo systemctl enable --now fail2ban
```

Si has cambiado el puerto SSH, reemplaza `22` por el valor configurado. Añade
`sudo ufw allow 80/tcp` solo si un proxy HTTP del host necesita recibir
conexiones en ese puerto. El panel de este Compose escucha únicamente en
`127.0.0.1:3000`: **no abras el puerto 3000 ni los puertos internos de Docker**
para publicarlo directamente.

En Debian puedes activar el jail de SSH de forma explícita:

```bash
sudo tee /etc/fail2ban/jail.d/sshd.local >/dev/null <<'EOF'
[sshd]
enabled = true
backend = systemd
EOF
sudo systemctl restart fail2ban
sudo fail2ban-client status
sudo fail2ban-client status sshd
```

Confirma que el jail `sshd` aparezca activo. Revisa las reglas con
`sudo ufw status verbose` y `sudo fail2ban-client status` después de cambios de
SSH o firewall. No copies reglas sin adaptarlas a tu acceso y a la política de
tu router.

#### Suspensión de un portátil

En un portátil que deba permanecer disponible al cerrar la tapa, crea una
configuración local de systemd-logind:

```bash
sudo install -d -m 0755 /etc/systemd/logind.conf.d
sudo tee /etc/systemd/logind.conf.d/10-servidor-sin-tapa.conf >/dev/null <<'EOF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
EOF
sudo reboot
```

El equipo se reiniciará y cerrará la sesión SSH. Espera a que vuelva a arrancar
y prueba con acceso físico o SSH que sigue respondiendo al cerrar la tapa. Esta
opción desactiva la suspensión por tapa, pero no evita una pérdida de energía,
sobrecalentamiento, fallo de batería, cierre manual o suspensión configurada
por otro mecanismo. Mantén el equipo ventilado y conectado a alimentación fiable.

### Herramientas de desarrollo

- **Docker Engine y el complemento Docker Compose v2** en el servidor. Sigue la
  [instalación oficial para Debian](https://docs.docker.com/engine/install/debian/);
  la guía recomienda configurar el repositorio APT oficial e instalar
  `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin` y
  `docker-compose-plugin`. Evita el script de conveniencia en producción.
- **Node.js 22 LTS y npm** en el equipo de desarrollo para instalar
  dependencias y ejecutar pruebas. Descarga el instalador desde
  [nodejs.org](https://nodejs.org/en/download). En el servidor de producción,
  Node.js y npm se ejecutan dentro de los contenedores; no hace falta
  instalarlos en Debian ni instalar allí los runtimes alojados.
- **Python 3.11 o posterior** para ejecutar el agente. Solo utiliza la
  biblioteca estándar de Python; no hay un `requirements.txt` para el agente.
  Debian 13 incluye Python 3.13.
- **Git** para clonar el repositorio del panel y para la importación de
  proyectos públicos.
- **Visual Studio Code** es opcional. Extensiones opcionales recomendadas:
  [Python](https://marketplace.visualstudio.com/items?itemName=ms-python.python),
  [Container Tools](https://marketplace.visualstudio.com/items?itemName=ms-azuretools.vscode-containers)
  y [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh).
  No son dependencias de ejecución; cualquier editor sirve.

#### Descargar y abrir el proyecto con Visual Studio Code

En tu equipo de trabajo (Windows, macOS o Linux), instala
[Visual Studio Code](https://code.visualstudio.com/download) y Git desde
[git-scm.com](https://git-scm.com/downloads). Descarga el repositorio con el
botón **Code → Download ZIP** y extrae el ZIP, o clónalo desde una terminal:

```bash
git clone https://github.com/ORGANIZACION/REPOSITORIO.git
cd REPOSITORIO
code .
```

Reemplaza `ORGANIZACION/REPOSITORIO` por la dirección HTTPS real. En Visual
Studio Code, **Archivo → Abrir carpeta** debe apuntar a la carpeta extraída que
contiene `package.json`, `docker-compose.yml` y este README; no abras solo la
carpeta `publico/`. Usa una terminal integrada con Node.js 22 y npm disponibles:

```bash
npm ci
npm run pruebas
```

`npm ci` descarga las dependencias declaradas por el lockfile y crea
`node_modules/` localmente. Esa carpeta es generada, puede ser grande, se
ignora con Git y no se debe subir ni editar a mano. Si borras `node_modules/`,
vuelve a ejecutar `npm ci`. Abrir la carpeta en VS Code no instala Debian,
Docker ni el agente del host; para un servidor real completa la guía
**Instalación en Debian** y ejecuta allí sus comandos. El archivo `.env` se
genera localmente o en el servidor y nunca se incluye en el ZIP/repositorio.

No hacen falta compiladores PHP, Rust, Go, Java, Ruby ni Node.js instalados en
el host para los despliegues: el agente usa imágenes de contenedor específicas.

### Componentes y dependencias del panel

| Componente | Uso |
| --- | --- |
| Node.js 22 LTS en la imagen del panel | Servidor, archivos, criptografía, sockets y procesos auxiliares |
| Express 5 | API HTTP, autenticación y entrega de la interfaz |
| `ws` 8 | WebSocket para la terminal interactiva |
| `@xterm/xterm` 6 | Emulador de terminal en el navegador |
| `@xterm/addon-fit` 0.11 | Ajuste de la terminal a su área visible |
| PHP 8.3 / Apache y PDO SQLite | Servicio interno de cuentas, hashes, invitaciones y sesiones persistentes |
| Python 3.11+ estándar | Agente local de métricas y operaciones del host |
| Docker Engine / Compose v2 | Aislamiento y ciclo de vida de los contenedores |
| systemd | Inicio automático y aislamiento del agente |

Las versiones exactas resueltas están en `package-lock.json`. Usa `npm ci` para
instalarlas de forma reproducible; no edites `node_modules` ni lo subas al
repositorio. El navegador obtiene xterm.js desde el servidor, no desde un CDN.

Las pruebas de la lógica de la interfaz/API están en Node.js; la suite del
almacén y de seguridad de cuentas está escrita y ejecutada en PHP:

```bash
npm run pruebas
npm run pruebas-php
```

La segunda requiere PHP CLI con `PDO_SQLITE` y `mbstring`; levanta el servicio
PHP en un puerto local temporal, verifica consultas preparadas, contraseñas,
sesiones, invitaciones y migración, y elimina sus datos temporales al terminar.
En Debian para desarrollo, instala esos módulos con
`sudo apt install php-cli php-sqlite3 php-mbstring`. No se necesita PHP CLI en
el servidor de producción: Compose construye el servicio PHP dentro de su
contenedor.

## Instalación en Debian

Los comandos siguientes usan valores de ejemplo. Puedes cambiar el usuario
Linux `panel`, la ruta del checkout `/opt/panel-servidor`, los directorios de
datos y el dominio. Si cambias el usuario, sustituye `panel` de forma
consistente en los comandos, en `User=` de la unidad systemd y en
`PANEL_UID`/`PANEL_GID`. Si cambias la raíz de proyectos, cambia también
`DIRECTORIO_PROYECTOS` y `ReadWritePaths` en la unidad systemd, y
`RUTA_PROYECTOS` en `.env`.

### 1. Instala Docker

La [guía oficial para Debian](https://docs.docker.com/engine/install/debian/)
es la fuente de instrucciones actualizadas. Estos son los pasos del
repositorio APT oficial para Debian Stable:

```bash
sudo apt update
sudo apt install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
sudo docker compose version
```

El repositorio no necesita C/C++ u otros compiladores instalados en Debian:
las compilaciones administradas se ejecutan en contenedores limitados. `htop`
y `btop` son herramientas opcionales para observar recursos del host:
`sudo apt install htop btop`.

La cuenta Linux del agente necesita acceso al grupo `docker`. Ese grupo concede
privilegios prácticamente equivalentes a root: usa una cuenta de servicio
dedicada y no añadas cuentas Linux de usuarios del panel a ese grupo. Este
permiso de sistema no limita quién puede descargar o contribuir al repositorio.
Docker gestiona sus propias reglas de red, que pueden interactuar con UFW.
Mantén los puertos publicados de contenedores cerrados al exterior salvo que
hayas revisado explícitamente su interfaz de escucha y sus reglas; en este
Compose, el panel queda ligado a `127.0.0.1`.

### 2. Crea la cuenta y directorios persistentes

```bash
sudo useradd --system --create-home --home-dir /var/lib/panel --shell /usr/sbin/nologin panel
sudo usermod -aG docker panel
sudo install -d -o panel -g panel -m 0750 /srv/panel/proyectos
sudo install -d -o panel -g panel -m 0750 /srv/panel/datos-panel
sudo install -d -o root -g root -m 0755 /opt/swatt-monitor
```

Si ya existe el usuario, no vuelvas a crearlo: verifica que pertenezca al grupo
Docker y que sea propietario de los directorios configurados. No almacenes el
checkout dentro del directorio de proyectos, que contiene datos importados.

### 3. Descarga el código y prepara el acceso

Reemplaza `ORGANIZACION/REPOSITORIO` con la URL HTTPS del fork o repositorio
que elegiste. El nombre del directorio local puede ser distinto del nombre en
GitHub.

```bash
sudo git clone https://github.com/ORGANIZACION/REPOSITORIO.git /opt/panel-servidor
sudo chown -R panel:panel /opt/panel-servidor
cd /opt/panel-servidor
sudo docker run --rm -it \
  --user "$(id -u panel):$(id -g panel)" \
  -v "$PWD:/app" -w /app \
  node:22-bookworm-slim node scripts/configurar-acceso.js
```

El asistente pide el nombre de usuario administrador y una contraseña de al
menos 14 caracteres, sin imprimirla. También pregunta si el panel se publicará
mediante HTTPS. Crea `.env` con permisos privados, un hash scrypt con sal
aleatoria y una clave aleatoria para autenticar las llamadas internas entre
Node y PHP. Se ejecuta con la imagen oficial Node.js 22 y la identidad de la
cuenta de servicio para que `.env` quede bajo esa cuenta; el servidor no
necesita instalar Node.js ni npm fuera de Docker. La primera vez Docker
descargará esa imagen. No reemplaces ni compartas el contenido de `.env`.

En una instalación que ya tenga `.env`, conserva el archivo y añade la clave
interna sin regenerar las credenciales:

```bash
cd /opt/panel-servidor
sudo docker run --rm \
  --user "$(id -u panel):$(id -g panel)" \
  -v "$PWD:/app" -w /app \
  node:22-bookworm-slim node scripts/configurar-cuentas-php.js
```

Añade a `.env` los valores requeridos por Docker Compose y protege el archivo.
El siguiente comando conserva la configuración y el hash creados por el
asistente:

```bash
sudo sh -c 'printf "\nPANEL_UID=%s\nPANEL_GID=%s\nDOCKER_GID=%s\nRUTA_PROYECTOS=/srv/panel/proyectos\nRUTA_DATOS_PANEL=/srv/panel/datos-panel\n" \
  "$(id -u panel)" "$(id -g panel)" "$(getent group docker | cut -d: -f3)" >> /opt/panel-servidor/.env'
sudo chmod 0600 /opt/panel-servidor/.env
```

`PANEL_UID` y `PANEL_GID` son la identidad con la que corre el contenedor web;
`DOCKER_GID` permite al panel comunicarse solo con el socket del agente. La
composición publica el panel en el puerto local 3000 por defecto. Para usar
otro puerto, agrega `PUERTO=NUMERO` a `.env` y sustituye 3000 en los comandos
de comprobación y en el proxy.

### 4. Instala y arranca el agente systemd

La unidad incluida es una plantilla de ejemplo. Antes de instalarla, edita
`despliegue/swatt-monitor.service` si elegiste otro usuario o raíz de
proyectos. Conserva el grupo Docker, `StateDirectory`, `RuntimeDirectory` y las
restricciones de systemd. El agente necesita escribir en la raíz de proyectos
para guardar el inventario y administrar archivos; esa ruta debe coincidir con
`RUTA_PROYECTOS`.

```bash
cd /opt/panel-servidor
sudo install -o root -g root -m 0644 agente/monitor_host.py /opt/swatt-monitor/monitor_host.py
sudo install -o root -g root -m 0644 despliegue/swatt-monitor.service /etc/systemd/system/swatt-monitor.service
sudo systemctl daemon-reload
sudo systemctl enable --now swatt-monitor.service
systemctl is-active swatt-monitor.service
```

El resultado esperado del último comando es `active`. El servicio lee métricas
cada cinco segundos y recibe operaciones por `/run/swatt-monitor/acciones.sock`.
Sus datos privados de runtimes y credenciales se guardan bajo
`/var/lib/swatt-monitor/`. La unidad limita escrituras y familias de red; no
uses `sudo` dentro del proceso del panel ni montes `/var/run/docker.sock` en el
contenedor web.

### 5. Inicia el panel y comprueba el estado

```bash
cd /opt/panel-servidor
sudo docker compose config --quiet
sudo docker compose up -d --build
sudo docker compose ps
curl --fail http://127.0.0.1:3000/api/salud
```

La respuesta de salud debe indicar `"estado":"correcto"`. Abre el servidor
mediante el proxy HTTPS configurado y entra con la cuenta creada. No configures
el proxy hasta haber decidido quién podrá acceder a él.

### 6. Acceso privado o público con Tailscale

Instala Tailscale siguiendo su
[documentación oficial](https://tailscale.com/docs/install) y autentica el
servidor. Para mantener el panel accesible solo a dispositivos autorizados en
la tailnet, usa Tailscale Serve:

```bash
sudo tailscale serve --bg 3000
tailscale serve status
```

Si quieres que personas que no pertenecen a la tailnet puedan abrir el panel,
puedes publicar su HTTPS con Tailscale Funnel:

```bash
tailscale funnel --bg 3000
tailscale funnel status
```

Comparte el hostname HTTPS que muestre el estado. Funnel hace que el panel sea
accesible desde Internet; **no** habilita el registro abierto. Cada cuenta nueva
requiere una invitación creada por un administrador. El enlace de invitación
vence a las 24 horas y se usa una sola vez. Las rutas de administración siguen
requiriendo iniciar sesión. Mantén `COOKIE_SECURE=true` para HTTPS. Este ejemplo
publica el panel en el puerto HTTPS 443; no publica automáticamente las
aplicaciones alojadas ni sus puertos. No habilites Funnel en otros puertos salvo
que también quieras hacerlos accesibles desde Internet. Si usas otro proxy,
configúralo para reenviar WebSocket además de HTTP y para confiar solo en el
proxy local.

## Uso del panel

### Acceso y usuarios

- El administrador inicial se define durante `npm run configurar-acceso`.
- No existe registro público de cuentas en una instancia. Desde **Usuarios**, el
  administrador crea una invitación y elige el rol. Comparte el enlace en
  privado: vence en 24 horas y solo se acepta una vez. Esta política de acceso
  afecta a la instancia desplegada, no a quién puede descargar o contribuir al
  repositorio.
- Un **Operador** administra únicamente los proyectos de los que es propietario.
  Un **Administrador** puede gestionar todos los proyectos, administrar
  invitaciones y usuarios y operar los contenedores visibles en Docker.
- Desde **Mi perfil**, cada cuenta puede cambiar el nombre y la contraseña.
  Cambiar la contraseña invalida sus otras sesiones.
- El inicio de sesión limita a cinco intentos por origen dentro de una ventana
  de quince minutos.
- Las cuentas, hashes, invitaciones y sesiones se guardan en SQLite mediante
  PDO en el volumen Docker `cuentas-php`. Al iniciar por primera vez, el
  servicio migra de forma transaccional las cuentas e invitaciones anteriores
  de `RUTA_DATOS_PANEL/usuarios.json`; conserva ese archivo hasta comprobar
  que el inicio de sesión funciona y completar una copia de seguridad. Después,
  archívalo cifrado o elimina la copia histórica: puede contener hashes scrypt
  anteriores a cambios recientes de contraseña.
  La solicitud de migración se limita a 20 MiB; si el JSON histórico supera
  ese tamaño, no se modifica ni se descarta, pero hace falta reducirlo o
  exportarlo mediante un procedimiento controlado antes de activar SQLite.
- Las nuevas contraseñas se guardan con `password_hash` (Argon2id si PHP lo
  admite; en otro caso, el algoritmo seguro predeterminado de PHP) y se
  verifican con `password_verify`. Los hashes scrypt anteriores se conservan
  durante la migración y se convierten al algoritmo de PHP al primer inicio
  de sesión correcto (Argon2id si está disponible; si no, el predeterminado
  seguro de PHP).
- Las sesiones duran ocho horas. El token aleatorio solo se envía en una cookie
  `HttpOnly`, `SameSite=Strict` y, en producción HTTPS, `Secure`; SQLite guarda
  su SHA-256, no el token reutilizable. Cerrar sesión, cambiar la contraseña o
  eliminar una cuenta revoca las sesiones correspondientes.

### Proyectos, revisión y archivos

1. En **Proyectos**, importa una URL HTTPS pública de GitHub o GitLab y elige
   rama y nombre. La importación no ejecuta código.
2. Revisa los archivos Compose detectados y el código antes de desplegar.
   Compose y Dockerfile se muestran para revisión, pero nunca se ejecutan.
3. **Archivos** permite navegar por el proyecto, editar texto, crear carpetas,
   cargar archivos de hasta 1 MiB y eliminar archivos. Las rutas permanecen
   dentro del proyecto; no se admiten enlaces simbólicos.
4. Un proyecto importado queda pendiente de revisión. Para actualizarlo desde
   el repositorio, vuelve a importar el código según el flujo de la interfaz.

GitHub y GitLab públicos son las únicas fuentes admitidas; repositorios
privados y submódulos no están soportados. La importación usa Git HTTPS, una
rama específica y clon superficial, sin hooks ni submódulos. Cada repositorio
se limita a 256 MiB y 25 000 archivos.

### Perfiles de despliegue

El proyecto debe contener los archivos indicados. Para HTML y PHP, se acepta
el punto de entrada en la raíz o un único `index.html`/`index.php` dentro de
una subcarpeta; el panel abre la vista previa directamente en ese archivo. Si
hay varios índices anidados, mueve el que corresponda a la raíz para evitar
ambigüedades. Todos los servidores web dinámicos deben escuchar en `0.0.0.0` y
en el puerto interno esperado; usar solo `localhost` o `127.0.0.1` impediría
que el proxy del panel los alcance:

| Perfil | Requisitos y proceso |
| --- | --- |
| HTML estático | `index.html` en la raíz o un único índice anidado; Nginx en el puerto 8080. |
| PHP 8.3 | `index.php` en la raíz o un único índice anidado; Apache en el puerto 80 (límite de ejecución 256 MiB, 0.5 CPU y 64 procesos). |
| Node.js 22 | `package.json` con script `start`; escucha en `PORT=3000`. Instala dependencias con `npm install`. |
| React | `package.json`, `package-lock.json` y script `build`; ejecuta `npm ci` y `npm run build`. Debe producir `dist/` o `build/`; Nginx sirve el resultado estático. |
| Python 3.12 | `app.py` y `requirements.txt`; ejecuta `python app.py` en el puerto 8000. Instala requisitos en `.swatt-packages`. |
| Ruby 3.3 | `Gemfile` y `config.ru`; Rack escucha en el puerto 3000. Instala gems en `vendor/bundle`. |
| Java 21 | `pom.xml`; Maven debe generar exactamente un JAR ejecutable en `target/` con `Main-Class`; escucha en 8080. |
| Kotlin | `pom.xml`; mismo proceso Maven/JAR que Java. |
| Go | `go.mod` y `main.go`; compila el paquete raíz y ejecuta el binario en 8080. |
| Rust | `Cargo.toml` con paquete válido; ejecuta el binario compilado en 8080. |

Las imágenes de ejecución y compilación están fijadas por el agente. Las
dependencias y scripts de construcción provienen del repositorio y se ejecutan
dentro de contenedores temporales de compilación (hasta 15 minutos, 1.5 GiB
RAM, 1.25 CPU y 256 procesos). Los contenedores de aplicaciones dinámicas
tienen límite de 512 MiB, 0.5 CPU y 128 procesos; tienen raíz de solo lectura,
sin capacidades Linux y una red interna por proyecto. El proceso puede
necesitar acceso a Internet para descargar paquetes durante la compilación.

Hay hasta cuatro aplicaciones gestionadas al mismo tiempo. El panel reserva un
puerto local del rango 18080–18179 para comunicarse con la aplicación. El
contenedor no publica puertos arbitrarios al host. Si quieres publicar una
aplicación para otros dispositivos, configura deliberadamente un proxy inverso
separado y limita su acceso; el panel no crea dominios ni reglas de proxy
público automáticamente. En tiempo de ejecución la red de la aplicación es
interna; no presupongas que puede iniciar conexiones salientes a Internet.
De forma predeterminada, Proyectos muestra un comando de ejemplo para abrir un
túnel SSH desde tu equipo. Sustituye `usuario@servidor` por tu cuenta y
dirección SSH; luego abre `http://127.0.0.1:<puerto>` en el mismo equipo donde
ejecutaste el túnel. Esto permite probar la aplicación sin publicar el puerto
ni abrirlo en el firewall.

Si el servidor ya pertenece a una tailnet Tailscale y quieres ofrecer un acceso
directo privado, puedes habilitarlo opcionalmente para el agente:

1. Con privilegios de administrador, autoriza a la cuenta de servicio del
   agente a configurar Tailscale Serve localmente. Consulta el usuario
   configurado en la unidad:

   ```bash
   systemctl show -p User --value swatt-monitor.service
   ```

   Copia la salida del primer comando y reemplaza `panel` si tu unidad usa
   otro usuario. Tailscale autoriza específicamente esa cuenta local:

   ```bash
   USUARIO_SERVICIO=panel
   sudo tailscale set --operator="$USUARIO_SERVICIO"
   ```

2. Crea una anulación de systemd para `swatt-monitor.service` con este contenido:

   ```ini
   [Unit]
   After=tailscaled.service

   [Service]
   Environment=SWATT_TAILSCALE_SERVE=true
   ```

   En Debian puedes crearla con `sudo systemctl edit swatt-monitor.service`.
3. Aplica el cambio y reinicia el agente:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart swatt-monitor.service
   systemctl is-active swatt-monitor.service
   ```

Al desplegar o iniciar aplicaciones, el agente configura un forwarding TCP
Tailscale solo para los puertos reservados del rango 18080–18179; al detenerlas
o archivarlas, lo retira. No reemplaza las rutas existentes del panel, no usa
Funnel y no requiere abrir esos puertos en UFW. La tarjeta del proyecto muestra
el enlace `http://<IP-Tailscale>:<puerto>` únicamente cuando el forwarding está
activo. Solo podrán llegar los dispositivos permitidos por las políticas de tu
tailnet. El tráfico viaja cifrado entre dispositivos Tailscale, pero la URL de
la aplicación usa HTTP; utiliza HTTPS propio si tu aplicación lo requiere.
Si no habilitas esta opción, sigue disponible el túnel SSH. Para exponer una
aplicación a Internet, configura aparte un proxy inverso con dominio, HTTPS y
las reglas de acceso que correspondan; no habilites Funnel por accidente.

### Bases de datos

Hay cuatro motores disponibles; el máximo actual es cuatro bases administradas
en total, una por proyecto:

| Motor | Imagen fijada | Puerto interno |
| --- | --- | --- |
| PostgreSQL | `postgres:17-alpine` | 5432 |
| MariaDB | `mariadb:11.4` | 3306 |
| MongoDB | `mongo:8.0` | 27017 |
| Redis | `redis:7-alpine` | 6379 |

Cada base usa un volumen Docker persistente, está conectada a la red interna de
su proyecto y no publica el puerto de la base en el host. El URI de conexión se
guarda como secreto en el directorio privado del agente, no en el registro de
proyectos ni en el repositorio. Los runtimes reciben el archivo de solo lectura
`/run/secrets/database-url`, señalado por `DATABASE_URL_FILE` y
`SWATT_DATABASE_URL_FILE`. Instala el driver correspondiente y lee el URI
desde ese archivo; no lo copies a código, logs ni variables versionadas. Para
revelar credenciales guardadas, el panel solicita confirmar el nombre exacto
del proyecto. PostgreSQL, MariaDB y MongoDB permiten elegir un identificador
de base seguro (minúsculas, dígitos y `_`, comenzando con una letra); Redis usa
el índice fijo `0`.

Si un runtime PHP antiguo no tiene montado `/run/secrets/database-url`, usa
**Aplicar cambios / recompilar** en la tarjeta del proyecto. El panel detecta
ese caso, retira de forma validada el contenedor viejo y lo recrea con el
montaje protegido, conservando el código y la red privada. Si la aplicación ya
tiene base asociada, se conserva su volumen y su URI secreta.

El panel muestra la ubicación real del código editable en
`DIRECTORIO_PROYECTOS/<id>` y la ruta `Mountpoint` del volumen obtenida con
`docker volume inspect`. La copia de trabajo aislada del runtime queda en
`/var/lib/swatt-monitor/runtimes/<id>/source`; el URI secreto del proyecto se
guarda en `/var/lib/swatt-monitor/secretos/<id>/database-url`. No edites
directamente el contenido del volumen Docker ni uses esas rutas para montar
directorios arbitrarios dentro de una aplicación.

Las bases no son copias de seguridad. Exporta y prueba restauraciones fuera del
host. Al eliminar un proyecto con base asociada, el código/runtime se elimina
pero la base queda archivada hasta que se elimine explícitamente. Borrar una
base elimina su volumen y es irreversible.

### Terminal interactiva

La sección **Terminal** abre Bash en un contenedor temporal para un único
proyecto. El sistema de archivos raíz es de solo lectura; la carpeta del
proyecto se monta en `/workspace` con escritura. La imagen incluye Bash, Git,
Node.js, Python, `pip`/`venv`, `curl` y herramientas de compilación. No monta el
socket Docker ni los otros proyectos.

La sesión conserva procesos, variables y directorio actual mientras WebSocket
permanezca conectado; al cerrar o perder la sesión se elimina el contenedor,
pero los cambios del proyecto permanecen. Cada terminal tiene límite de 512
MiB, 0.75 CPU, 64 procesos y un `/tmp` temporal de 128 MiB. Hay cuatro PTY
simultáneas en el agente y un máximo de dos sesiones por cuenta y ocho cuentas
conectadas desde el panel. La salida a Internet está habilitada y no se filtra
por dominios. Por lo tanto, comparte
esta función solo con cuentas de colaboradores a quienes quieras dar acceso al
código del proyecto: los límites Docker no convierten una cuenta de usuario en
un aislamiento fuerte frente al host. Esta recomendación se refiere a las
invitaciones de una instancia desplegada, no al acceso al repositorio público.

## Datos, configuración y copias de seguridad

| Dato | Ubicación de ejemplo | Contiene |
| --- | --- | --- |
| Configuración de acceso | `.env` del checkout | Hash inicial, clave interna y parámetros; no versionar ni compartir |
| Migración de cuentas | `/srv/panel/datos-panel/usuarios.json` del host | Copia de origen de la migración; no es el almacén activo tras migrar |
| Cuentas, invitaciones y sesiones | Volumen Docker `cuentas-php` | SQLite con PDO; no eliminar el volumen al actualizar o limpiar Docker |
| Proyectos e inventario | `/srv/panel/proyectos/` del host | Repositorios importados y archivo `.registro-swatt.json` con propietarios y estados |
| Runtimes y secretos | `/var/lib/swatt-monitor/` | Copias de runtime preparadas y archivos privados de conexión de bases |
| Imágenes y volúmenes | Almacenamiento Docker del host | Imágenes y datos persistentes de aplicaciones y bases de datos |

Restringe permisos y realiza copias de seguridad coherentes de cuentas,
proyectos, secretos y volúmenes. Guarda las copias cifradas fuera del host y
prueba la restauración. Los comandos `docker system prune --volumes` y
`docker volume prune` pueden destruir datos; no los ejecutes como limpieza
automática sin verificar qué volúmenes se eliminarían.

#### Copia de seguridad inicial de la instancia

Haz una copia antes de actualizar, migrar o eliminar servicios. El archivo
`.env` y el estado del agente contienen secretos: limita permisos y cifra la
copia antes de transferirla fuera del servidor. El siguiente ejemplo guarda
archivos del host y el volumen SQLite del servicio de cuentas; ejecútalo desde
el directorio de instalación y conserva toda la secuencia en una sola terminal
Bash:

```bash
cd /opt/panel-servidor
sudo install -d -m 0700 /srv/panel/resguardos
VOLUMEN_CUENTAS="$(sudo docker volume ls --filter label=com.docker.compose.volume=cuentas-php --format '{{.Name}}' | head -n 1)"
if [ -z "$VOLUMEN_CUENTAS" ]; then
  echo "No se encontró el volumen de cuentas; detente y comprueba docker volume ls."
  exit 1
fi
sudo docker compose stop panel php-cuentas
FECHA="$(date +%Y%m%d-%H%M%S)"
sudo tar --numeric-owner -czf "/srv/panel/resguardos/archivos-$FECHA.tar.gz" \
  /opt/panel-servidor/.env \
  /srv/panel/proyectos \
  /srv/panel/datos-panel \
  /var/lib/swatt-monitor
sudo docker run --rm \
  -v "$VOLUMEN_CUENTAS:/origen:ro" \
  -v /srv/panel/resguardos:/respaldo \
  alpine:3.21 tar -C /origen -czf "/respaldo/cuentas-$FECHA.tar.gz" .
sudo docker compose up -d
sudo chmod 0600 /srv/panel/resguardos/*.tar.gz
sudo docker compose ps
```

El contenedor auxiliar solo lee el volumen de SQLite; no borres el volumen
para recuperar espacio. Comprueba que ambos archivos existen y que los
servicios vuelven a estar sanos antes de desconectarte. Una copia del volumen
de SQLite no sustituye exportaciones consistentes de las bases de datos de
aplicaciones: exporta PostgreSQL, MariaDB, MongoDB o Redis con sus herramientas
nativas, o detén cada base antes de copiar su volumen. Identifica y respalda
también todos los volúmenes de datos de proyectos; el ejemplo no los incluye.
Guarda copias cifradas fuera del host y practica la restauración en otro
volumen o un host de prueba antes de depender de ellas.

No configures como limpieza programada `docker system prune -af --volumes` ni
`docker volume prune`: pueden eliminar imágenes, cachés y volúmenes de datos
que la aplicación todavía necesite. El panel no instala una tarea Cron de
limpieza automática. Una instalación de referencia tenía configurada una
limpieza semanal con `docker system prune -af --volumes`; este README no
recomienda ni crea esa tarea porque puede borrar volúmenes persistentes de
servicios detenidos. Si reutilizas un host existente, revisa sus tareas
programadas y elimina esa limpieza destructiva antes de confiarle datos.
Revisa el destino exacto antes de cualquier limpieza.

Las variables principales en `.env` son:

| Variable | Propósito |
| --- | --- |
| `PUERTO` | Puerto local del panel; valor inicial 3000. |
| `ENTORNO` | `produccion` o `desarrollo`; producción requiere cookies seguras. |
| `COOKIE_SECURE` | `true` al usar HTTPS; el asistente pregunta durante la creación. |
| `ADMIN_USERNAME` | Cuenta administradora inicial elegida por quien instala. |
| `ADMIN_PASSWORD_HASH` | Hash scrypt generado por el asistente, no una contraseña en texto. |
| `CUENTAS_API_SECRETO` | Clave aleatoria de 256 bits para autenticar Node con PHP; no reutilizar ni compartir. |
| `PANEL_UID`, `PANEL_GID` | Identidad Linux usada por el contenedor web. |
| `DOCKER_GID` | GID del grupo Docker para el socket del agente. |
| `RUTA_PROYECTOS` | Directorio persistente montado como `/app/proyectos`. |
| `RUTA_DATOS_PANEL` | Directorio persistente montado como `/var/lib/swatt-panel`. |

`.env.example` es una referencia; no contiene credenciales y no debe usarse
como `.env` de producción sin completar la configuración. `ARCHIVO_USUARIOS`
se conserva para que Node lea el archivo JSON legado durante la migración. El
contenedor PHP no publica puertos al host, no tiene salida de red y solo es
accesible para el panel en una red Docker interna; su SQLite vive en el volumen
persistente `cuentas-php`.

## Medidas de seguridad de la aplicación

- **Consultas e inyecciones:** el servicio PHP usa PDO SQLite con consultas
  preparadas y parámetros enlazados para los valores recibidos. Los nombres de
  usuario y roles también se validan con listas permitidas; no se construye SQL
  concatenando datos del cliente.
- **Contraseñas y credenciales:** PHP genera y verifica los hashes de cuentas
  con `password_hash`/`password_verify`; los tokens de invitación se guardan como
  SHA-256 y son de un solo uso. La contraseña inicial se recibe como hash desde
  `.env`; nunca se guarda en texto claro.
- **Sesiones y cookies:** tokens aleatorios, persistidos en SQLite solo como
  hashes, con vencimiento de ocho horas. La cookie es `HttpOnly` y
  `SameSite=Strict`; producción exige `Secure`. Cambiar contraseña invalida las
  sesiones anteriores. Una reinicialización del contenedor no elimina las
  sesiones porque persisten en el volumen.
- **XSS:** los datos de usuarios y proyectos se insertan en el DOM con
  `textContent` o propiedades de formulario. Las páginas de acceso y registro
  usan scripts externos; una Content Security Policy prohíbe scripts inline,
  objetos y marcos. Las imágenes de perfil se limitan a formatos raster
  permitidos y se validan por firma.
- **CSRF:** cada operación que cambia estado comprueba un encabezado `Origin`
  exactamente igual al origen recibido, y la cookie `SameSite=Strict` añade
  protección adicional. El WebSocket de terminal también valida el origen.
- **Archivos:** las rutas se restringen a la carpeta del proyecto y no aceptan
  enlaces simbólicos; el editor limita cada archivo a 1 MiB y las fotos de
  perfil a 512 KiB. Las cargas requieren sesión, propiedad del proyecto y
  protección de mismo origen.
- **PHP:** el servicio de cuentas no acepta cargas multipart; desactiva la
  exposición de errores y funciones de ejecución de comandos, y limita memoria,
  tiempos, variables y rutas de lectura. Las cargas de archivos de proyecto
  siguen entrando por la API Node autenticada: se limita el tamaño, se valida
  la ruta dentro del proyecto, se rechazan enlaces simbólicos y las fotos de
  perfil se validan por tamaño, tipo declarado y firma binaria. El contenedor
  PHP se ejecuta sin privilegios, con sistema de archivos de solo lectura,
  recursos limitados y red interna sin salida.
- **Encabezados HTTP:** el panel envía CSP, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` y controles de
  aislamiento entre orígenes; activa HSTS cuando se configura HTTPS.

Estas medidas reducen riesgos, pero no sustituyen mantener Debian, Docker, las
imágenes y dependencias actualizados, limitar quién recibe invitaciones,
proteger `.env` y realizar copias de seguridad verificadas. El servicio PHP es
un componente de la aplicación, no una garantía absoluta contra fallos o
vulnerabilidades futuras.

## API del panel

La API es privada salvo la comprobación de salud y las rutas necesarias para
iniciar sesión o aceptar una invitación. Los cambios de estado validan la sesión
y el origen; los endpoints de proyecto vuelven a comprobar la propiedad antes
de leer o modificar datos.

| Área | Operaciones principales |
| --- | --- |
| Acceso | `GET /api/salud`; inicio y cierre de sesión; consultar sesión; aceptar invitación; actualizar perfil |
| Usuarios | Listar usuarios e invitaciones, crear/revocar invitaciones y revocar cuentas (solo administrador) |
| Estado y Docker | Métricas del host (solo administrador); listar contenedores y ejecutar acciones permitidas con confirmación (solo administrador) |
| Proyectos | Listar/importar, actualizar desde Git, revisar Compose, desplegar/operar runtime y eliminar |
| Archivos | Listar carpetas, leer/guardar/eliminar archivos y crear directorios |
| Bases de datos | Crear, consultar credenciales con confirmación y eliminar bases archivadas |
| Terminal | WebSocket autenticado para PTY Bash; la ruta JSON de comandos es un endpoint heredado distinto |

La página principal, la API privada y la terminal WebSocket requieren sesión.
Las hojas CSS, los scripts del navegador y los módulos de xterm.js son recursos
estáticos públicos: contienen solo código de interfaz y no exponen cuentas,
proyectos ni configuración. Las operaciones y datos del panel siguen protegidos
por sesión; la política CSP mantiene los scripts limitados al mismo origen y
permite únicamente los estilos dinámicos que necesita xterm.js.
Las rutas completas y los métodos HTTP se definen en `src/servidor.js` y
`src/servicios/autenticacion.js`; no son una API pública estable para clientes
externos.

## Desarrollo local

Para editar y ejecutar las pruebas unitarias en tu equipo de trabajo necesitas
Node.js 22, npm y Python 3.11 o posterior. No instales dependencias editando
`node_modules/`; utiliza `npm ci`:

```bash
npm ci
npm run pruebas
python -m unittest discover -s tests -p "test_*.py"
```

El servidor Node no funciona por sí solo fuera de Docker Compose: la API de
cuentas está en el servicio PHP y Node lo busca por su nombre interno
`php-cuentas`. Para probar la interfaz con autenticación, sigue la
**Instalación en Debian** y entra al panel por HTTPS o mediante un túnel SSH.
Para una instancia local de desarrollo en Linux también se necesita Docker
Compose y una configuración `.env` válida; las métricas, terminal y operaciones
del host requieren además instalar el agente systemd real. No ejecutes
`npm run desarrollo` directamente en Windows esperando obtener el panel
completo.

Para verificar cambios de sintaxis:

```bash
node --check src/servidor.js
node --check src/servicios/docker.js
node --check publico/scripts/panel.js
python -m py_compile agente/monitor_host.py
```

No ejecutes el agente como un servicio del host en Windows. Las funciones PTY,
systemd y Docker de producción están dirigidas a Debian/Linux. El proyecto no
incluye un runtime web general de C/C++ ni compila firmware Arduino.

## Actualización

Haz una copia de seguridad antes de actualizar. Desde la raíz del checkout,
obtén la versión deseada y actualiza primero el agente; después reconstruye y
recrea el panel:

```bash
sudo -u panel -H git -C /opt/panel-servidor pull --ff-only
cd /opt/panel-servidor
sudo install -o root -g root -m 0644 agente/monitor_host.py /opt/swatt-monitor/monitor_host.py
sudo install -o root -g root -m 0644 despliegue/swatt-monitor.service /etc/systemd/system/swatt-monitor.service
sudo systemctl daemon-reload
sudo systemctl restart swatt-monitor.service
systemctl is-active swatt-monitor.service
sudo docker compose config --quiet
sudo docker compose up -d --build --force-recreate
sudo docker compose ps
curl --fail http://127.0.0.1:3000/api/salud
```

El agente debe indicar `active` antes de recrear el panel. La reconstrucción
invalida las sesiones actuales. Revisa los registros si falla el arranque:

```bash
sudo systemctl status swatt-monitor.service
sudo journalctl -u swatt-monitor.service -n 100 --no-pager
sudo docker compose logs --tail=100 panel
```

## Solución de problemas

- **El panel no inicia:** ejecuta `sudo docker compose ps` y
  `sudo docker compose logs --tail=100 panel`; valida `.env` y
  `sudo docker compose config --quiet`.
- **No hay métricas o aparece agente no disponible:** comprueba
  `systemctl is-active swatt-monitor.service`, el journal y los permisos del
  directorio montado en `/run/swatt-monitor`.
  Si el agente está `active` pero el panel informa `ECONNREFUSED`, recrea el
  panel con `sudo docker compose up -d --force-recreate`: las versiones
  anteriores montaban el archivo del socket directamente y podían conservar
  una referencia obsoleta después de reiniciar el agente. Las versiones
  actuales montan el directorio para seguir el socket nuevo.
- **La importación falla:** verifica la URL HTTPS pública, la rama, Git y la
  salida a Internet del servidor. El panel no importa repositorios privados.
- **Falla una compilación:** valida el manifiesto y los archivos requeridos,
  que la aplicación use el puerto indicado y que los paquetes puedan
  descargarse. La interfaz devuelve un error genérico; revisa el journal del
  agente para detalles de Docker.
- **Falla la terminal al iniciar:** confirma que Docker está activo y puede
  descargar `node:22-bookworm-slim` y los paquetes Debian. La primera sesión
  construye una imagen auxiliar y puede tardar; comprueba el journal del agente
  y vuelve a intentar cuando la imagen esté creada.
- **HTTPS/cookie de acceso:** `COOKIE_SECURE=true` requiere entrar por HTTPS;
  para desarrollo HTTP local usa `COOKIE_SECURE=false`. No uses la opción HTTP
  en un despliegue público.
- **No abre una aplicación desplegada:** si configuraste el acceso Tailscale,
  comprueba que el dispositivo esté en la misma tailnet y que el agente esté
  activo. Revisa `journalctl -u swatt-monitor.service` si el forwarding no se
  creó. Si no habilitaste Tailscale Serve, copia el comando de túnel SSH del
  proyecto, ejecútalo en una terminal local y abre la URL localhost.

## Seguridad y uso responsable

- No publiques `.env`, el archivo de cuentas, secretos, claves, repositorios de
  usuarios ni copias de seguridad.
- El repositorio de código puede ser público; los datos anteriores pertenecen
  a cada instalación y no deben subirse a GitHub.
- Protege SSH, HTTPS, Docker y el panel en la red; usa cuentas y contraseñas
  individuales. Comparte las invitaciones de acceso solo con las personas a
  quienes quieras autorizar en tu instancia.
- El usuario del agente pertenece al grupo Docker, que puede controlar
  contenedores y acceder al host. No concedas este acceso a usuarios del panel.
- El panel no monta `docker.sock`, pero el agente sí necesita acceso al daemon
  Docker para ejecutar las operaciones permitidas.
- El panel solo acepta repositorios públicos y perfiles administrados. Revisar
  un Compose no garantiza que el código de la aplicación sea seguro.
- Los builds ejecutan dependencias y scripts de terceros con acceso a red.
  Inspecciona el código y sus dependencias antes de desplegarlos en tu servidor;
  no ejecutes código malicioso o que no estés dispuesto a permitir en ese host.
  Esto no impide descargar ni estudiar repositorios públicos.
- El proyecto no instala tareas cron de limpieza y no elimina automáticamente
  volúmenes como mantenimiento. Planifica el mantenimiento manualmente y
  conserva copias de seguridad verificadas.
- La terminal tiene salida de red sin filtro de dominios. El firewall del host
  y la configuración de redes deben ser parte de tu evaluación de riesgos.
- Revisa regularmente actualizaciones de Debian, Docker, Node.js, imágenes de
  runtime y dependencias npm.

## Créditos

Creación e implementación inicial: **Jonás Beren (Swatt)**. El código se
distribuye bajo la licencia MIT; consulta el archivo `LICENSE` para sus
condiciones.

Cada administrador debe elegir los nombres de usuario, hostname, rutas de
datos, dominio y método de acceso de su propia instalación. Los nombres
internos del servicio y las rutas de ejemplo son convenciones técnicas del
repositorio; no identifican el hostname ni la cuenta personal de quien lo
despliega.
