<?php
declare(strict_types=1);

$raiz = dirname(__DIR__, 2);
$temporal = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'swatt-php-' . bin2hex(random_bytes(8));
if (!mkdir($temporal, 0700)) {
    throw new RuntimeException('No se pudo crear el directorio temporal de pruebas.');
}

$secreto = bin2hex(random_bytes(32));
$hashAdministrador = password_hash('clave-administrador-de-prueba', PASSWORD_DEFAULT);
$tokenLegado = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
$archivoLegado = $temporal . DIRECTORY_SEPARATOR . 'usuarios.json';
$baseDatos = $temporal . DIRECTORY_SEPARATOR . 'cuentas.sqlite';
$puertoSocket = stream_socket_server('tcp://127.0.0.1:0', $errno, $error);
if ($puertoSocket === false) {
    throw new RuntimeException("No se pudo reservar un puerto local: {$error} ({$errno}).");
}
$direccionSocket = stream_socket_get_name($puertoSocket, false);
fclose($puertoSocket);
$puerto = (int) substr(strrchr((string) $direccionSocket, ':'), 1);

$jsonLegado = [
    'usuarios' => [[
        'id' => '0123456789abcdef0123456789abcdef',
        'usuario' => 'administrador',
        'nombre' => 'Administrador',
        'rol' => 'administrador',
        'hashContrasena' => $hashAdministrador,
        'creadoEn' => (int) floor(microtime(true) * 1000),
    ]],
    'invitaciones' => [[
        'hashToken' => hash('sha256', $tokenLegado),
        'usuario' => 'invitado-legado',
        'rol' => 'operador',
        'venceEn' => (int) floor(microtime(true) * 1000) + 60000,
    ]],
];
file_put_contents($archivoLegado, json_encode($jsonLegado, JSON_THROW_ON_ERROR), LOCK_EX);
chmod($archivoLegado, 0600);

putenv('CUENTAS_API_SECRETO=' . $secreto);
putenv('CUENTAS_DB=' . $baseDatos);
putenv('ADMIN_USERNAME=administrador');
putenv('ADMIN_PASSWORD_HASH=' . $hashAdministrador);
$salida = [];
$proceso = proc_open(
    [PHP_BINARY, '-S', "127.0.0.1:{$puerto}", dirname(__DIR__) . DIRECTORY_SEPARATOR . 'index.php'],
    [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ],
    $tuberias,
    $raiz,
    null,
    ['bypass_shell' => true],
);
if (!is_resource($proceso)) {
    throw new RuntimeException('No se pudo iniciar PHP para la prueba de integración.');
}
fclose($tuberias[0]);
stream_set_blocking($tuberias[1], false);
stream_set_blocking($tuberias[2], false);

function comprobar(bool $condicion, string $mensaje): void
{
    if (!$condicion) {
        throw new RuntimeException($mensaje);
    }
}

function solicitudPhp(string $url, ?array $cuerpo, string $secreto, string $tipo = 'application/json'): array
{
    $cabeceras = [
        'Content-Type: ' . $tipo,
        'X-Cuentas-Api-Secreto: ' . $secreto,
    ];
    $opciones = [
        'http' => [
            'method' => $cuerpo === null ? 'GET' : 'POST',
            'header' => implode("\r\n", $cabeceras),
            'ignore_errors' => true,
            'timeout' => 3,
        ],
    ];
    if ($cuerpo !== null) {
        $opciones['http']['content'] = json_encode($cuerpo, JSON_THROW_ON_ERROR);
    }
    $contenido = file_get_contents($url, false, stream_context_create($opciones));
    $estado = 0;
    foreach ($http_response_header ?? [] as $cabecera) {
        if (preg_match('/^HTTP\/\S+\s+(\d+)/', $cabecera, $coincidencia)) {
            $estado = (int) $coincidencia[1];
        }
    }
    return [$estado, is_string($contenido) ? json_decode($contenido, true, 32, JSON_THROW_ON_ERROR) : null];
}

try {
    $url = "http://127.0.0.1:{$puerto}/";
    $listo = false;
    for ($intento = 0; $intento < 100; $intento++) {
        [$estado] = solicitudPhp($url . 'health', null, '');
        if ($estado === 200) {
            $listo = true;
            break;
        }
        usleep(25000);
    }
    comprobar($listo, 'El servicio PHP no inició o PDO SQLite no está disponible.');

    [$estadoSinClave] = solicitudPhp($url, ['accion' => 'listar_usuarios'], '');
    comprobar($estadoSinClave === 403, 'La API PHP aceptó una solicitud sin clave interna.');
    [$estadoMime] = solicitudPhp($url, ['accion' => 'listar_usuarios'], $secreto, 'text/plain');
    comprobar($estadoMime === 415, 'La API PHP aceptó un tipo de contenido incorrecto.');

    [$estado, $respuesta] = solicitudPhp($url, [
        'accion' => 'inicializar',
        'cuentasLegadas' => $jsonLegado,
    ], $secreto);
    comprobar($estado === 200 && ($respuesta['correcto'] ?? false), 'No se migraron las cuentas históricas.');

    [$estado, $login] = solicitudPhp($url, [
        'accion' => 'iniciar_sesion',
        'usuario' => 'administrador',
        'contrasena' => 'clave-administrador-de-prueba',
    ], $secreto);
    comprobar($estado === 200 && ($login['correcto'] ?? false), 'El inicio de sesión PHP no validó la contraseña.');
    comprobar(preg_match('/^[A-Za-z0-9_-]{43}$/', $login['tokenSesion'] ?? '') === 1, 'PHP no generó un token de sesión aleatorio.');

    $fotoPrueba = 'data:image/png;base64,iVBORw0KGgo=';
    [$estado, $perfilConFoto] = solicitudPhp($url, [
        'accion' => 'actualizar_perfil',
        'id' => $login['cuenta']['id'],
        'nombre' => 'Administrador',
        'fotoPerfil' => $fotoPrueba,
    ], $secreto);
    comprobar(
        $estado === 200 && ($perfilConFoto['cuenta']['fotoPerfil'] ?? null) === $fotoPrueba,
        'El perfil no devolvió la foto guardada.',
    );

    [$estado, $sesionLigera] = solicitudPhp($url, [
        'accion' => 'obtener_sesion',
        'token' => $login['tokenSesion'],
    ], $secreto);
    comprobar(
        $estado === 200
        && isset($sesionLigera['sesion'])
        && !array_key_exists('fotoPerfil', $sesionLigera['sesion']),
        'La consulta normal de sesión incluyó la foto de perfil.',
    );
    [$estado, $sesionCompleta] = solicitudPhp($url, [
        'accion' => 'obtener_sesion',
        'token' => $login['tokenSesion'],
        'incluirFoto' => true,
    ], $secreto);
    comprobar(
        $estado === 200
        && ($sesionCompleta['sesion']['fotoPerfil'] ?? null) === $fotoPrueba,
        'La consulta de perfil no recuperó la foto persistida para la sesión.',
    );

    [$estado, $invitacion] = solicitudPhp($url, [
        'accion' => 'crear_invitacion',
        'usuario' => 'operador-prueba',
        'rol' => 'operador',
    ], $secreto);
    comprobar($estado === 200 && isset($invitacion['token']), 'No se pudo crear una invitación.');
    [$estado, $cuenta] = solicitudPhp($url, [
        'accion' => 'aceptar_invitacion',
        'token' => $invitacion['token'],
        'nombre' => 'Operador',
        'contrasena' => 'una-contrasena-segura-de-prueba',
    ], $secreto);
    comprobar($estado === 200 && ($cuenta['cuenta']['usuario'] ?? '') === 'operador-prueba', 'No se pudo aceptar la invitación.');
    comprobar(isset($cuenta['cuenta']['tokenSesion']), 'El alta PHP no creó una sesión.');

    [$estado] = solicitudPhp($url, [
        'accion' => 'aceptar_invitacion',
        'token' => $invitacion['token'],
        'nombre' => 'Reutilizada',
        'contrasena' => 'otra-contrasena-segura-de-prueba',
    ], $secreto);
    comprobar($estado === 400, 'La invitación se pudo volver a usar.');

    [$estado, $perfil] = solicitudPhp($url, [
        'accion' => 'actualizar_perfil',
        'id' => $cuenta['cuenta']['id'],
        'nombre' => "'; DROP TABLE usuarios; --",
        'contrasenaActual' => 'una-contrasena-segura-de-prueba',
        'nuevaContrasena' => 'una-clave-nueva-segura-de-prueba',
    ], $secreto);
    comprobar($estado === 200 && ($perfil['cuenta']['nombre'] ?? '') === "'; DROP TABLE usuarios; --", 'La consulta preparada no conservó de forma segura el texto recibido.');

    [$estado, $sesionRevocada] = solicitudPhp($url, [
        'accion' => 'obtener_sesion',
        'token' => $cuenta['cuenta']['tokenSesion'],
    ], $secreto);
    comprobar(
        $estado === 200
        && array_key_exists('sesion', $sesionRevocada)
        && $sesionRevocada['sesion'] === null,
        'El cambio de contraseña no revocó la sesión anterior.',
    );

    $base = new PDO('sqlite:' . $baseDatos, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $consultaHash = $base->prepare('SELECT hash_contrasena FROM usuarios WHERE usuario = :usuario');
    $consultaHash->execute([':usuario' => 'operador-prueba']);
    $hash = $consultaHash->fetchColumn();
    comprobar(is_string($hash) && password_verify('una-clave-nueva-segura-de-prueba', $hash), 'La contraseña no está guardada como un hash verificable.');

    echo "Correcto: PDO, consultas preparadas, hashes, migración, sesiones, invitaciones y rechazo de acceso inválido.\n";
} finally {
    proc_terminate($proceso);
    foreach ([1, 2] as $indice) {
        stream_get_contents($tuberias[$indice]);
        fclose($tuberias[$indice]);
    }
    proc_close($proceso);
    $consultaHash = null;
    $base = null;
    gc_collect_cycles();
    foreach (glob($temporal . DIRECTORY_SEPARATOR . '*') ?: [] as $archivo) {
        if (!unlink($archivo)) {
            throw new RuntimeException("No se pudo eliminar el archivo temporal de pruebas: {$archivo}.");
        }
    }
    if (!rmdir($temporal)) {
        throw new RuntimeException("No se pudo eliminar el directorio temporal de pruebas: {$temporal}.");
    }
}
