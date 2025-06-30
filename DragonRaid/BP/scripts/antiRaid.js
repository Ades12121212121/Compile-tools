import { world, system, Player } from "@minecraft/server";

// ========== CONFIGURACIÓN ==========
const CONFIG = {
    TNT: {
        MAX_EXPLOSIONS: 5,
        TIME_FRAME_MS: 3000,
        DISABLE_TIME_TICKS: 200 // 10 segundos
    },
    BLOCK_BREAKING: {
        MAX_BREAKS: 15,
        TIME_FRAME_MS: 5000,
        FREEZE_TIME_TICKS: 100 // 5 segundos
    },
    MOVEMENT: {
        MAX_SPEED: 2.0,
        TELEPORT_DISTANCE: 50
    },
    COMMANDS: {
        MAX_COMMANDS: 8,
        TIME_FRAME_MS: 2000,
        MUTE_TIME_TICKS: 600 // 30 segundos
    },
    ITEM_DROP: {
        MAX_DROPS: 20,
        TIME_FRAME_MS: 3000
    },
    FALLING_BLOCKS: {
        MAX_FALLING_BLOCKS: 30,
        CHECK_RADIUS: 20,
        CLEANUP_INTERVAL: 100
    }
};

// ========== VARIABLES GLOBALES ==========
let tntTimes = [];
let playerData = new Map();
let suspiciousPlayers = new Set();
let fallingBlocksCount = 0;
let fallingBlocksData = [];
let activeTNTEntities = [];
let lastTNTCheck = Date.now();

// ========== SISTEMA AVANZADO ANTI-FALSOS POSITIVOS ==========
// Buffer de historial de acciones por jugador (últimos 30 segundos)
let playerActionHistory = new Map();
let globalMovementStats = {
    avgSpeed: 0,
    maxSpeed: 0,
    samples: 0
};

// ========== PROTECCIÓN ANTI-RAID DE ENTIDADES HOSTILES ==========
const HOSTILE_MOBS = [
    "minecraft:zombie","minecraft:skeleton","minecraft:creeper","minecraft:spider","minecraft:enderman",
    "minecraft:blaze","minecraft:witch","minecraft:slime","minecraft:magma_cube","minecraft:phantom",
    "minecraft:warden","minecraft:ravager","minecraft:evoker","minecraft:vindicator","minecraft:pillager",
    "minecraft:shulker","minecraft:guardian","minecraft:elder_guardian","minecraft:endermite","minecraft:ender_dragon"
];
let hostileSpawnBlockedUntil = 0;

// ========== FUNCIONES AUXILIARES ==========
function getPlayerData(playerId) {
    if (!playerData.has(playerId)) {
        playerData.set(playerId, {
            blockBreaks: [],
            lastPosition: null,
            commandUsage: [],
            itemDrops: [],
            warnings: 0,
            isFrozen: false,
            isMuted: false,
            blockPlacements: [],
            itemUsage: [],
            tntPlacements: [],
            playTime: 0,
            joinTime: Date.now(),
            stats: {
                blocksBroken: 0,
                blocksPlaced: 0,
                tntPlaced: 0,
                commandsUsed: 0,
                itemsUsed: 0,
                itemsDropped: 0,
                lastActions: []
            }
        });
    }
    return playerData.get(playerId);
}

function cleanOldEntries(array, timeFrame) {
    const now = Date.now();
    return array.filter(time => now - time <= timeFrame);
}

function warnPlayer(player, reason) {
    try {
        if (!player || !player.isValid()) return;

        const data = getPlayerData(player.id);
        data.warnings++;

        player.sendMessage(`§c⚠️ Advertencia ${data.warnings}/3: ${reason}`);
        world.sendMessage(`§e${player.name} ha recibido una advertencia: ${reason}`);

        if (data.warnings >= 3) {
            kickSuspiciousPlayer(player, "Múltiples advertencias");
        }
    } catch (error) {
        console.warn("Error en warnPlayer:", error);
    }
}

function kickSuspiciousPlayer(player, reason) {
    try {
        if (!player || !player.isValid()) return;

        world.sendMessage(`§c🚫 ${player.name} ha sido expulsado: ${reason}`);

        const data = getPlayerData(player.id);
        data.isFrozen = true;
        player.sendMessage("§c🚫 Has sido congelado por comportamiento sospechoso.");

        // Intentar expulsar usando diferentes métodos
        system.run(() => {
            try {
                player.runCommand("kick @s Expulsado por comportamiento sospechoso");
            } catch (e) {
                // Si falla, mantener congelado
                player.sendMessage("§c🚫 Permaneces congelado hasta revisión manual.");
            }
        });
    } catch (error) {
        console.warn("Error en kickSuspiciousPlayer:", error);
    }
}

function isPlayerOp(player) {
    try {
        if (player.isOp) {
            return player.isOp();
        }
        // Método alternativo si isOp() no funciona
        if (player.hasTag) {
            return player.hasTag("admin") || player.hasTag("op");
        }
        return false;
    } catch (error) {
        return false;
    }
}

function isCreative(player) {
    try {
        if (player.getGameMode) {
            return player.getGameMode() === "creative";
        }
        // Alternativa por tag
        if (player.hasTag) {
            return player.hasTag("creative");
        }
        return false;
    } catch {
        return false;
    }
}

function getTrustLevel(playerId) {
    const data = getPlayerData(playerId);
    // Jugadores con más de 10h jugadas y menos de 2 advertencias son de alta confianza
    if (data.playTime >= 10 * 60 * 60 * 1000 && data.warnings < 2) return 'alta';
    // Más de 2h jugadas y menos de 3 advertencias: media
    if (data.playTime >= 2 * 60 * 60 * 1000 && data.warnings < 3) return 'media';
    return 'baja';
}

function formatPlayTime(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${h}h ${m}m ${s}s`;
}

// ========== TNT TRACKING AVANZADO ==========
// Rastrear entidades TNT activas
world.afterEvents.entitySpawn.subscribe((event) => {
    try {
        const entity = event.entity;
        if (!entity || !entity.isValid()) return;
        if (entity.typeId === "minecraft:tnt") {
            activeTNTEntities.push({
                entity: entity,
                spawnTime: Date.now(),
                location: { ...entity.location }
            });
        }
    } catch (error) {
        console.warn("Error rastreando TNT activa:", error);
    }
});

// Limpiar TNT explotada/desaparecida periódicamente
system.runInterval(() => {
    try {
        const now = Date.now();
        activeTNTEntities = activeTNTEntities.filter(tnt => tnt.entity && tnt.entity.isValid() && (now - tnt.spawnTime) < 20000);
    } catch (error) {
        console.warn("Error limpiando TNT activa:", error);
    }
}, 40);

// ========== PROTECCIÓN CONTRA TNT ========== 
world.afterEvents.explosion.subscribe((event) => {
    try {
        const now = Date.now();
        let location = null;
        let nearestPlayer = null;
        let minDistance = Infinity;

        // Obtener ubicación de la explosión
        if (event.source && event.source.location) {
            location = event.source.location;
        } else if (event.dimension) {
            const blocks = event.getImpactedBlocks();
            if (blocks && blocks.length > 0) {
                const firstBlock = blocks[0];
                location = { x: firstBlock.x, y: firstBlock.y, z: firstBlock.z };
            }
        }

        // Buscar jugador más cercano a la explosión
        if (location) {
            for (const player of world.getPlayers()) {
                if (!player.isValid()) continue;
                const dx = player.location.x - location.x;
                const dy = player.location.y - location.y;
                const dz = player.location.z - location.z;
                const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (distance < minDistance && distance <= 15) {
                    minDistance = distance;
                    nearestPlayer = player;
                }
            }
        }

        // Registrar explosión
        tntTimes.push({
            time: now,
            player: nearestPlayer,
            location: location
        });
        tntTimes = tntTimes.filter(entry => now - entry.time <= CONFIG.TNT.TIME_FRAME_MS);

        // Limpiar TNT activa cerca de la explosión
        if (location) {
            activeTNTEntities = activeTNTEntities.filter(tnt => {
                const dx = tnt.location.x - location.x;
                const dy = tnt.location.y - location.y;
                const dz = tnt.location.z - location.z;
                return Math.sqrt(dx * dx + dy * dy + dz * dz) > 5;
            });
        }

        // Verificar si hay demasiadas explosiones
        if (tntTimes.length >= CONFIG.TNT.MAX_EXPLOSIONS) {
            try {
                const dimensions = ["overworld", "nether", "the_end"];
                for (const dimName of dimensions) {
                    try {
                        const dimension = world.getDimension(dimName);
                        if (dimension) {
                            dimension.runCommand("gamerule tntexplodes false");
                        }
                    } catch (e) {
                        console.warn(`Error desactivando TNT en ${dimName}:`, e);
                    }
                }
                if (nearestPlayer && location) {
                    const coords = `${Math.floor(location.x)}, ${Math.floor(location.y)}, ${Math.floor(location.z)}`;
                    world.sendMessage(`§c🧨 ALERTA TNT: ${nearestPlayer.name} activó múltiples explosiones en ${coords}`);
                    warnPlayer(nearestPlayer, "Activación masiva de TNT detectada");
                } else {
                    world.sendMessage("§c⚠️ TNT desactivada por posible raid - Múltiples explosiones detectadas.");
                }
                system.runTimeout(() => {
                    try {
                        for (const dimName of dimensions) {
                            try {
                                const dimension = world.getDimension(dimName);
                                if (dimension) {
                                    dimension.runCommand("gamerule tntexplodes true");
                                }
                            } catch (e) {
                                console.warn(`Error reactivando TNT en ${dimName}:`, e);
                            }
                        }
                        world.sendMessage("§a✅ TNT reactivada en todas las dimensiones.");
                        tntTimes = [];
                    } catch (e) {
                        console.warn("Error reactivando TNT:", e);
                        world.sendMessage("§c⚠️ Error reactivando TNT - Revisar manualmente.");
                    }
                }, CONFIG.TNT.DISABLE_TIME_TICKS);
            } catch (error) {
                console.warn("Error desactivando TNT:", error);
                world.sendMessage("§c⚠️ Error en sistema anti-TNT - Revisar configuración.");
            }
        }
    } catch (error) {
        console.warn("Error en protección TNT:", error);
    }
});

// Verificación cruzada: demasiada TNT activa aunque no explote
system.runInterval(() => {
    try {
        if (activeTNTEntities.length > 20) {
            const dimensions = ["overworld", "nether", "the_end"];
            for (const dimName of dimensions) {
                try {
                    const dimension = world.getDimension(dimName);
                    if (dimension) {
                        dimension.runCommand("gamerule tntexplodes false");
                    }
                } catch (e) {
                    console.warn(`Error forzando desactivación de TNT en ${dimName}:`, e);
                }
            }
            world.sendMessage("§c🧨 TNT desactivada por exceso de entidades activas (posible lag/bug). Admin revisar zona de TNT.");
            // Limpiar entidades rastreadas para evitar spam
            activeTNTEntities = [];
            // Reactivar después de un tiempo
            system.runTimeout(() => {
                try {
                    for (const dimName of dimensions) {
                        try {
                            const dimension = world.getDimension(dimName);
                            if (dimension) {
                                dimension.runCommand("gamerule tntexplodes true");
                            }
                        } catch (e) {
                            console.warn(`Error reactivando TNT en ${dimName}:`, e);
                        }
                    }
                    world.sendMessage("§a✅ TNT reactivada tras control de entidades.");
                } catch (e) {
                    console.warn("Error reactivando TNT tras control de entidades:", e);
                }
            }, CONFIG.TNT.DISABLE_TIME_TICKS);
        }
    } catch (error) {
        console.warn("Error en verificación cruzada de TNT:", error);
    }
}, 20);

// Protección adicional: Detectar colocación masiva de TNT
world.beforeEvents.playerPlaceBlock.subscribe((event) => {
    try {
        const player = event.player;
        if (!player || !player.isValid()) return;

        const block = event.block;
        if (!block) return;

        // Verificar si el bloque que se va a colocar es TNT
        if (event.permutationToPlace && event.permutationToPlace.type && event.permutationToPlace.type.id === "minecraft:tnt") {
            const data = getPlayerData(player.id);

            if (!data.tntPlacements) data.tntPlacements = [];

            const now = Date.now();
            data.tntPlacements.push(now);
            data.tntPlacements = cleanOldEntries(data.tntPlacements, 5000); // 5 segundos

            // Si coloca más de 3 TNT en 5 segundos
            if (data.tntPlacements.length > 3) {
                event.cancel = true;
                warnPlayer(player, "Colocación masiva de TNT detectada");
                player.sendMessage("§c🚫 No puedes colocar tanto TNT tan rápido.");

                const coords = `${Math.floor(block.location.x)}, ${Math.floor(block.location.y)}, ${Math.floor(block.location.z)}`;
                world.sendMessage(`§c🧨 ${player.name} intentó colocar TNT masivamente en ${coords}`);
            }
        }
    } catch (error) {
        console.warn("Error en protección de colocación de TNT:", error);
    }
});

// ========== PROTECCIÓN CONTRA ROTURA MASIVA DE BLOQUES ==========
world.beforeEvents.playerBreakBlock.subscribe((event) => {
    try {
        const player = event.player;
        if (!player || !player.isValid()) return;
        if (isPlayerOp(player) || isCreative(player)) return;
        
        let allowFastBreak = false;
        try {
            const item = player.getComponent && player.getComponent("minecraft:equipped_item")?.itemStack;
            if (item && item.getComponent) {
                const ench = item.getComponent("minecraft:enchantments");
                if (ench && ench.enchantments) {
                    const eff = ench.enchantments.find(e => e.id === "efficiency");
                    if (eff && eff.level >= 4) allowFastBreak = true;
                }
            }
        } catch { }
        
        if (allowFastBreak) return;
        
        const data = getPlayerData(player.id);
        data.stats.blocksBroken++;
        data.stats.lastActions.push({ type: 'break', time: Date.now(), block: event.block?.typeId });
        if (data.stats.lastActions.length > 20) data.stats.lastActions.shift();
        
        if (data.isFrozen) {
            event.cancel = true;
            player.sendMessage("§c🚫 Estás congelado y no puedes romper bloques.");
            return;
        }
        
        const now = Date.now();
        data.blockBreaks.push(now);
        data.blockBreaks = cleanOldEntries(data.blockBreaks, CONFIG.BLOCK_BREAKING.TIME_FRAME_MS);
        
        // Ajustar tolerancia según confianza
        let maxBreaks = CONFIG.BLOCK_BREAKING.MAX_BREAKS;
        const trust = getTrustLevel(player.id);
        if (trust === 'alta') maxBreaks *= 2;
        else if (trust === 'media') maxBreaks = Math.floor(maxBreaks * 1.5);
        
        if (data.blockBreaks.length >= maxBreaks) {
            data.isFrozen = true;
            suspiciousPlayers.add(player.id);
            warnPlayer(player, `Rotura masiva de bloques detectada (Confianza: ${trust})`);
            
            system.runTimeout(() => {
                try {
                    data.isFrozen = false;
                    if (player.isValid()) {
                        player.sendMessage("§a✅ Ya puedes volver a romper bloques.");
                    }
                } catch (e) {
                    console.warn("Error desbloqueando jugador:", e);
                }
            }, CONFIG.BLOCK_BREAKING.FREEZE_TIME_TICKS);
            
            event.cancel = true;
        }
    } catch (error) {
        console.warn("Error en protección de bloques:", error);
    }
});

// ========== PROTECCIÓN ANTI-LAG ARENA ==========
world.afterEvents.entitySpawn.subscribe((event) => {
    try {
        const entity = event.entity;
        if (!entity || !entity.isValid()) return;

        if (entity.typeId === "minecraft:falling_block") {
            const now = Date.now();
            fallingBlocksData.push({
                entity: entity,
                spawnTime: now,
                location: { ...entity.location }
            });

            fallingBlocksCount++;

            if (fallingBlocksCount > CONFIG.FALLING_BLOCKS.MAX_FALLING_BLOCKS) {
                let nearestPlayer = null;
                let minDistance = Infinity;

                for (const player of world.getPlayers()) {
                    if (!player.isValid()) continue;

                    const dx = player.location.x - entity.location.x;
                    const dy = player.location.y - entity.location.y;
                    const dz = player.location.z - entity.location.z;
                    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

                    if (distance < minDistance && distance <= 20) {
                        minDistance = distance;
                        nearestPlayer = player;
                    }
                }

                try {
                    entity.remove();
                    fallingBlocksCount--;

                    const coords = `${Math.floor(entity.location.x)}, ${Math.floor(entity.location.y)}, ${Math.floor(entity.location.z)}`;
                    if (nearestPlayer) {
                        world.sendMessage(`§c🏖️ LAG ARENA: ${nearestPlayer.name} causó lag masivo con arena en ${coords}`);
                        warnPlayer(nearestPlayer, "Lag masivo con bloques que caen detectado");
                    } else {
                        world.sendMessage(`§c⚠️ Protección anti-lag activada: Reduciendo bloques que caen en ${coords}`);
                    }
                } catch (error) {
                    console.warn("Error eliminando bloque que cae:", error);
                }
            }
        }

        // Protección general contra spawn masivo de entidades
        if (entity.typeId !== "minecraft:falling_block" && entity.typeId !== "minecraft:player") {
            try {
                const dimension = world.getDimension("overworld");
                if (dimension) {
                    const sameTypeEntities = dimension.getEntities({
                        type: entity.typeId
                    });

                    if (sameTypeEntities.length > 50) {
                        let nearestPlayer = null;
                        let minDistance = Infinity;

                        for (const player of world.getPlayers()) {
                            if (!player.isValid()) continue;

                            const dx = player.location.x - entity.location.x;
                            const dy = player.location.y - entity.location.y;
                            const dz = player.location.z - entity.location.z;
                            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

                            if (distance < minDistance && distance <= 30) {
                                minDistance = distance;
                                nearestPlayer = player;
                            }
                        }

                        entity.remove();
                        const coords = `${Math.floor(entity.location.x)}, ${Math.floor(entity.location.y)}, ${Math.floor(entity.location.z)}`;

                        if (nearestPlayer) {
                            world.sendMessage(`§c🐛 SPAM ENTIDADES: ${nearestPlayer.name} generó muchas ${entity.typeId} en ${coords}`);
                            warnPlayer(nearestPlayer, `Spawn masivo de entidades (${entity.typeId}) detectado`);
                        } else {
                            world.sendMessage(`§c⚠️ Spawn masivo de ${entity.typeId} detectado en ${coords} - entidad eliminada.`);
                        }
                    }
                }
            } catch (error) {
                console.warn("Error en protección de entidades:", error);
            }
        }
    } catch (error) {
        console.warn("Error en entitySpawn:", error);
    }
});

// Limpiar datos de bloques que caen periódicamente
system.runInterval(() => {
    try {
        const now = Date.now();
        const validBlocks = [];

        for (const blockData of fallingBlocksData) {
            if (blockData.entity && blockData.entity.isValid() && (now - blockData.spawnTime) < 30000) {
                validBlocks.push(blockData);
            } else {
                fallingBlocksCount--;
            }
        }

        fallingBlocksData = validBlocks;

        if (fallingBlocksCount < 0) fallingBlocksCount = 0;
    } catch (error) {
        console.warn("Error en limpieza de bloques:", error);
    }
}, CONFIG.FALLING_BLOCKS.CLEANUP_INTERVAL);

// ========== PROTECCIÓN CONTRA SPEED HACKS Y TELEPORT (SISTEMA AVANZADO) ==========
system.runInterval(() => {
    try {
        for (const player of world.getPlayers()) {
            if (!player.isValid() || isPlayerOp(player) || isCreative(player)) continue;
            
            const data = getPlayerData(player.id);
            const currentPos = player.location;
            
            if (data.lastPosition) {
                const dx = currentPos.x - data.lastPosition.x;
                const dy = currentPos.y - data.lastPosition.y;
                const dz = currentPos.z - data.lastPosition.z;
                const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
                
                // Usar el nuevo sistema avanzado anti-falsos positivos
                if (isMovementSuspicious(player, distance, currentPos, data.lastPosition)) {
                    const reason = distance > CONFIG.MOVEMENT.TELEPORT_DISTANCE ? 
                        "Posible teleport hack detectado" : 
                        "Movimiento sospechoso detectado";
                    
                    handleMovementSuspicion(player, reason);
                    
                    // Solo teletransportar si es muy sospechoso (teleport hack)
                    if (distance > CONFIG.MOVEMENT.TELEPORT_DISTANCE) {
                        try {
                            player.teleport(data.lastPosition);
                        } catch (e) {
                            console.warn("Error teletransportando jugador:", e);
                        }
                    }
                }
            }
            data.lastPosition = { ...currentPos };
        }
    } catch (error) {
        console.warn("Error en protección de movimiento avanzada:", error);
    }
}, 4); // Cada 4 ticks para mejor rendimiento

// ========== PROTECCIÓN CONTRA SPAM DE COMANDOS ==========
world.beforeEvents.chatSend.subscribe((event) => {
    try {
        const player = event.sender;
        const message = event.message;
        if (!player || !player.isValid()) return;
        
        if (message.startsWith('/')) {
            const data = getPlayerData(player.id);
            data.stats.commandsUsed++;
            data.stats.lastActions.push({ type: 'command', time: Date.now(), command: message });
            if (data.stats.lastActions.length > 20) data.stats.lastActions.shift();
            
            if (data.isMuted) {
                event.cancel = true;
                player.sendMessage("§c🚫 Estás silenciado temporalmente.");
                return;
            }
            
            const now = Date.now();
            data.commandUsage.push(now);
            data.commandUsage = cleanOldEntries(data.commandUsage, CONFIG.COMMANDS.TIME_FRAME_MS);
            
            // Ajustar tolerancia según confianza
            let maxCmds = CONFIG.COMMANDS.MAX_COMMANDS;
            const trust = getTrustLevel(player.id);
            if (trust === 'alta') maxCmds *= 2;
            else if (trust === 'media') maxCmds = Math.floor(maxCmds * 1.5);
            
            if (data.commandUsage.length >= maxCmds) {
                data.isMuted = true;
                warnPlayer(player, `Spam de comandos detectado (Confianza: ${trust})`);
                
                system.runTimeout(() => {
                    try {
                        data.isMuted = false;
                        if (player.isValid()) {
                            player.sendMessage("§a✅ Ya puedes usar comandos nuevamente.");
                        }
                    } catch (e) {
                        console.warn("Error desmutando jugador:", e);
                    }
                }, CONFIG.COMMANDS.MUTE_TIME_TICKS);
                
                event.cancel = true;
            }
        }
    } catch (error) {
        console.warn("Error en protección de comandos:", error);
    }
});

// ========== PROTECCIÓN CONTRA ITEM SPAM ==========
world.afterEvents.itemSpawn.subscribe((event) => {
    try {
        const entity = event.entity;
        if (!entity || !entity.isValid()) return;
        
        // Registrar drop por jugador si es posible
        if (entity.owner && entity.owner.typeId === 'minecraft:player') {
            const data = getPlayerData(entity.owner.id);
            data.stats.itemsDropped++;
            data.stats.lastActions.push({ type: 'drop', time: Date.now(), item: entity.typeId });
            if (data.stats.lastActions.length > 20) data.stats.lastActions.shift();
        }
        
        const now = Date.now();
        const dimension = world.getDimension("overworld");
        if (dimension) {
            const items = dimension.getEntities({
                type: "minecraft:item"
            });

            if (items.length > CONFIG.ITEM_DROP.MAX_DROPS) {
                try {
                    event.entity.remove();
                    world.sendMessage("§c⚠️ Item spam detectado - items eliminados.");
                } catch (error) {
                    console.warn("Error eliminando item:", error);
                }
            }
        }
    } catch (error) {
        console.warn("Error en protección de items:", error);
    }
});

// ========== PROTECCIONES ADICIONALES ==========
// Protección contra colocación masiva de bloques
world.beforeEvents.playerPlaceBlock.subscribe((event) => {
    try {
        const player = event.player;
        if (!player || !player.isValid() || isPlayerOp(player)) return;
        
        const data = getPlayerData(player.id);
        data.stats.blocksPlaced++;
        data.stats.lastActions.push({ type: 'place', time: Date.now(), block: event.block?.typeId });
        if (data.stats.lastActions.length > 20) data.stats.lastActions.shift();
        
        const now = Date.now();
        data.blockPlacements.push(now);
        data.blockPlacements = cleanOldEntries(data.blockPlacements, 2000);
        
        if (data.blockPlacements.length > 10) {
            event.cancel = true;
            warnPlayer(player, "Colocación masiva de bloques detectada");
        }
    } catch (error) {
        console.warn("Error en protección de colocación:", error);
    }
});

// Protección contra uso masivo de items
world.beforeEvents.itemUse.subscribe((event) => {
    try {
        const player = event.source;
        if (!player || !player.isValid() || isPlayerOp(player)) return;
        
        const data = getPlayerData(player.id);
        data.stats.itemsUsed++;
        data.stats.lastActions.push({ type: 'use', time: Date.now(), item: event.item?.typeId });
        if (data.stats.lastActions.length > 20) data.stats.lastActions.shift();
        
        const now = Date.now();
        data.itemUsage.push(now);
        data.itemUsage = cleanOldEntries(data.itemUsage, 1000);
        
        if (data.itemUsage.length > 15) {
            event.cancel = true;
            warnPlayer(player, "Uso masivo de items detectado");
        }
    } catch (error) {
        console.warn("Error en protección de uso de items:", error);
    }
});

// ========== LIMPIEZA AUTOMÁTICA DEL HISTORIAL DE ACCIONES ==========
system.runInterval(() => {
    try {
        const now = Date.now();
        const onlinePlayerIds = new Set(world.getPlayers().map(p => p.id));

        // Limpiar historial de jugadores desconectados
        for (const [playerId, history] of playerActionHistory.entries()) {
            if (!onlinePlayerIds.has(playerId)) {
                playerActionHistory.delete(playerId);
                continue;
            }
            
            // Limpiar datos antiguos
            cleanOldHistory(history);
            
            // Resetear sospecha si el cooldown expiró
            if (history.suspicionCooldown < now) {
                history.isSuspicious = false;
            }
        }

        // Limpiar datos de jugadores desconectados del sistema principal
        for (const playerId of playerData.keys()) {
            if (!onlinePlayerIds.has(playerId)) {
                playerData.delete(playerId);
                suspiciousPlayers.delete(playerId);
            }
        }

        // Mostrar jugadores bajo vigilancia
        if (suspiciousPlayers.size > 0) {
            const suspiciousNames = world.getPlayers()
                .filter(p => p.isValid() && suspiciousPlayers.has(p.id))
                .map(p => p.name)
                .join(", ");

            if (suspiciousNames) {
                world.sendMessage(`§e👀 Jugadores bajo vigilancia: ${suspiciousNames}`);
            }
        }
    } catch (error) {
        console.warn("Error en limpieza automática:", error);
    }
}, 600);

// ========== COMANDOS ADMINISTRATIVOS ==========
world.afterEvents.chatSend.subscribe((event) => {
    try {
        const player = event.sender;
        const message = event.message;
        if (!player || !player.isValid() || !isPlayerOp(player)) return;
        
        const msg = message.toLowerCase();
        
        if (msg.startsWith('!antiraid stats ')) {
            const name = msg.replace('!antiraid stats ', '').trim();
            const target = world.getPlayers().find(p => p.name.toLowerCase() === name.toLowerCase());
            if (!target) {
                player.sendMessage(`§cNo se encontró al jugador ${name}`);
                return;
            }
            const data = getPlayerData(target.id);
            player.sendMessage(`§e=== ESTADÍSTICAS DE ${target.name} ===`);
            player.sendMessage(`§eTiempo jugado: ${formatPlayTime(data.playTime)}`);
            player.sendMessage(`§eNivel de confianza: ${getTrustLevel(target.id)}`);
            player.sendMessage(`§eAdvertencias: ${data.warnings}`);
            player.sendMessage(`§eBloques rotos: ${data.stats.blocksBroken}`);
            player.sendMessage(`§eBloques colocados: ${data.stats.blocksPlaced}`);
            player.sendMessage(`§eTNT colocada: ${data.stats.tntPlaced}`);
            player.sendMessage(`§eComandos usados: ${data.stats.commandsUsed}`);
            player.sendMessage(`§eItems usados: ${data.stats.itemsUsed}`);
            player.sendMessage(`§eItems dropeados: ${data.stats.itemsDropped}`);
            player.sendMessage(`§eÚltimas acciones: `);
            for (const act of data.stats.lastActions.slice(-10)) {
                player.sendMessage(`§7- ${act.type} (${new Date(act.time).toLocaleTimeString()}) ${act.block || act.item || act.command || ''}`);
            }
        }
        
        if (msg === '!antiraid status') {
            const suspiciousCount = suspiciousPlayers.size;
            const totalWarnings = Array.from(playerData.values())
                .reduce((sum, data) => sum + data.warnings, 0);
            player.sendMessage(`§e=== ESTADO ANTI-RAID ===`);
            player.sendMessage(`§eJugadores sospechosos: ${suspiciousCount}`);
            player.sendMessage(`§eAdvertencias totales: ${totalWarnings}`);
            player.sendMessage(`§eExplosiones recientes: ${tntTimes.length}`);
            player.sendMessage(`§eBloques cayendo activos: ${fallingBlocksCount}`);
        }
        
        if (msg === '!antiraid reset') {
            playerData.clear();
            suspiciousPlayers.clear();
            tntTimes = [];
            fallingBlocksCount = 0;
            fallingBlocksData = [];
            player.sendMessage("§a✅ Sistema anti-raid reiniciado.");
            world.sendMessage("§aEl sistema anti-raid ha sido reiniciado por un administrador.");
        }
        
        if (msg === '!antiraid help') {
            player.sendMessage("§e=== COMANDOS ANTI-RAID ===");
            player.sendMessage("§e!antiraid status - Ver estado del sistema");
            player.sendMessage("§e!antiraid reset - Reiniciar sistema");
            player.sendMessage("§e!antiraid help - Mostrar esta ayuda");
            player.sendMessage("§e!antiraid stats <jugador> - Estadísticas de un jugador");
            player.sendMessage("§e!antiraid movement - Estadísticas de movimiento global");
            player.sendMessage("§e!antiraid tnt - Estado de TNT activa");
        }
        
        if (msg === '!antiraid movement') {
            player.sendMessage("§e=== ESTADÍSTICAS DE MOVIMIENTO GLOBAL ===");
            player.sendMessage(`§eMuestras recopiladas: ${globalMovementStats.samples}`);
            player.sendMessage(`§eVelocidad promedio: ${globalMovementStats.avgSpeed.toFixed(2)}`);
            player.sendMessage(`§eVelocidad máxima: ${globalMovementStats.maxSpeed.toFixed(2)}`);
            player.sendMessage(`§eJugadores con historial: ${playerActionHistory.size}`);
            
            // Mostrar jugadores con comportamiento sospechoso
            const suspiciousPlayers = [];
            for (const [playerId, history] of playerActionHistory.entries()) {
                if (history.isSuspicious) {
                    const targetPlayer = world.getPlayers().find(p => p.id === playerId);
                    if (targetPlayer) {
                        suspiciousPlayers.push(targetPlayer.name);
                    }
                }
            }
            if (suspiciousPlayers.length > 0) {
                player.sendMessage(`§cJugadores sospechosos: ${suspiciousPlayers.join(", ")}`);
            } else {
                player.sendMessage("§aNingún jugador marcado como sospechoso.");
            }
        }
        
        if (msg === '!antiraid tnt') {
            player.sendMessage("§e=== ESTADO DE TNT ===");
            player.sendMessage(`§eTNT activas rastreadas: ${activeTNTEntities.length}`);
            player.sendMessage(`§eExplosiones recientes: ${tntTimes.length}`);
            
            if (activeTNTEntities.length > 0) {
                player.sendMessage("§eÚltimas ubicaciones de TNT activa:");
                for (let i = 0; i < Math.min(5, activeTNTEntities.length); i++) {
                    const tnt = activeTNTEntities[i];
                    const coords = `${Math.floor(tnt.location.x)}, ${Math.floor(tnt.location.y)}, ${Math.floor(tnt.location.z)}`;
                    const age = Math.floor((Date.now() - tnt.spawnTime) / 1000);
                    player.sendMessage(`§7- ${coords} (${age}s atrás)`);
                }
            }
        }
    } catch (error) {
        console.warn("Error en comandos administrativos:", error);
    }
});

// ========== TRACKING DE TIEMPO JUGADO Y ESTADÍSTICAS ===========
// Actualiza playTime y joinTime cada minuto
system.runInterval(() => {
    try {
        for (const player of world.getPlayers()) {
            if (!player.isValid()) continue;
            const data = getPlayerData(player.id);
            const now = Date.now();
            if (!data.joinTime) data.joinTime = now;
            data.playTime += now - data.joinTime;
            data.joinTime = now;
        }
    } catch (error) {
        console.warn("Error actualizando tiempo jugado:", error);
    }
}, 1200); // cada minuto

// ========== MENSAJE DE INICIO ==========
system.run(() => {
    try {
        world.sendMessage("§a✅ Sistema Anti-Raid v3.0 activado!");
        world.sendMessage("§eProtecciones: TNT avanzada, Anti-falsos positivos, Speed/Teleport hacks, Spam comandos, Item spam, Anti-lag arena");
        world.sendMessage("§eComandos: !antiraid status, !antiraid reset, !antiraid help, !antiraid stats <jugador>");
        world.sendMessage("§eNuevos: !antiraid movement, !antiraid tnt");
        world.sendMessage("§a🎯 Sistema anti-falsos positivos activo - Aprende el comportamiento normal de cada jugador");
    } catch (error) {
        console.warn("Error en mensaje de inicio:", error);
    }
});

// ========== Función para obtener historial de acciones del jugador ==========
function getPlayerActionHistory(playerId) {
    if (!playerActionHistory.has(playerId)) {
        playerActionHistory.set(playerId, {
            movements: [],
            actions: [],
            lastUpdate: Date.now(),
            normalSpeed: 0,
            speedSamples: 0,
            isSuspicious: false,
            suspicionCooldown: 0
        });
    }
    return playerActionHistory.get(playerId);
}

// ========== Función para limpiar historial antiguo ==========
function cleanOldHistory(history, maxAge = 30000) {
    const now = Date.now();
    history.movements = history.movements.filter(m => now - m.time <= maxAge);
    history.actions = history.actions.filter(a => now - a.time <= maxAge);
}

// ========== Función para detectar estados legítimos que pueden causar velocidad alta ==========
function isLegitimateHighSpeed(player) {
    try {
        // Sprinting
        if (player.isSprinting && player.isSprinting()) return true;
        
        // Flying (creative mode)
        if (player.isFlying && player.isFlying()) return true;
        
        // Gliding (Elytra)
        if (player.isGliding && player.isGliding()) return true;
        
        // Swimming
        if (player.isSwimming && player.isSwimming()) return true;
        
        // Riding (montando algo)
        if (player.isRiding && player.isRiding()) return true;
        
        // Jumping (saltando)
        const velocity = player.getVelocity();
        if (velocity && velocity.y > 0.3) return true;
        
        // Efectos de pociones
        const effects = player.getEffects();
        if (effects) {
            for (const effect of effects) {
                if (effect.typeId === "speed" || effect.typeId === "jump_boost" || 
                    effect.typeId === "levitation" || effect.typeId === "slow_falling") {
                    return true;
                }
            }
        }
        
        return false;
    } catch (error) {
        return false;
    }
}

// ========== Función para detectar lag del servidor ==========
function isServerLagging() {
    try {
        // Si hay muchos jugadores o el tick rate está bajo
        const playerCount = world.getPlayers().length;
        return playerCount > 20; // Ajustar según tu servidor
    } catch {
        return false;
    }
}

// ========== Función para calcular velocidad promedio del jugador ==========
function calculatePlayerAverageSpeed(playerId) {
    const history = getPlayerActionHistory(playerId);
    if (history.movements.length < 5) return CONFIG.MOVEMENT.MAX_SPEED;
    
    const speeds = history.movements.map(m => m.speed);
    const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    return Math.min(avgSpeed * 1.5, CONFIG.MOVEMENT.MAX_SPEED * 3); // Tolerancia del 50%
}

// ========== Función para actualizar estadísticas globales ==========
function updateGlobalStats(speed) {
    globalMovementStats.samples++;
    globalMovementStats.avgSpeed = (globalMovementStats.avgSpeed * (globalMovementStats.samples - 1) + speed) / globalMovementStats.samples;
    globalMovementStats.maxSpeed = Math.max(globalMovementStats.maxSpeed, speed);
}

// ========== Función para verificar si el movimiento es sospechoso ==========
function isMovementSuspicious(player, distance, currentPos, lastPos) {
    try {
        const playerId = player.id;
        const history = getPlayerActionHistory(playerId);
        const now = Date.now();
        
        // Limpiar historial antiguo
        cleanOldHistory(history);
        
        // Si está en cooldown de sospecha, no verificar
        if (history.suspicionCooldown > now) return false;
        
        // Verificar estados legítimos
        if (isLegitimateHighSpeed(player)) return false;
        
        // Verificar lag del servidor
        if (isServerLagging()) return false;
        
        // Calcular velocidad promedio personalizada del jugador
        const playerAvgSpeed = calculatePlayerAverageSpeed(playerId);
        
        // Añadir movimiento al historial
        history.movements.push({
            time: now,
            speed: distance,
            position: currentPos,
            isSprinting: player.isSprinting && player.isSprinting(),
            isFlying: player.isFlying && player.isFlying(),
            isGliding: player.isGliding && player.isGliding()
        });
        
        // Actualizar estadísticas globales
        updateGlobalStats(distance);
        
        // Verificar si la velocidad es sospechosa
        const isSuspicious = distance > playerAvgSpeed * 2.5; // 2.5x su promedio personal
        
        // Si es sospechoso, verificar contra estadísticas globales
        if (isSuspicious) {
            const globalThreshold = globalMovementStats.avgSpeed * 3;
            if (distance < globalThreshold) {
                // Falso positivo probable, no marcar como sospechoso
                return false;
            }
        }
        
        return isSuspicious;
    } catch (error) {
        console.warn("Error verificando movimiento sospechoso:", error);
        return false;
    }
}

// ========== Función para manejar sospecha de movimiento ==========
function handleMovementSuspicion(player, reason) {
    try {
        const playerId = player.id;
        const history = getPlayerActionHistory(playerId);
        const now = Date.now();
        
        // Si ya está marcado como sospechoso, no duplicar
        if (history.isSuspicious) return;
        
        history.isSuspicious = true;
        history.suspicionCooldown = now + 30000; // 30 segundos de cooldown
        
        // Advertencia suave primero
        player.sendMessage(`§e⚠️ Movimiento inusual detectado: ${reason}`);
        
        // Solo advertir al admin si es muy sospechoso
        if (reason.includes("teleport") || reason.includes("hack")) {
            warnPlayer(player, reason);
        }
        
        // Auto-limpiar sospecha después del cooldown
        system.runTimeout(() => {
            try {
                const currentHistory = getPlayerActionHistory(playerId);
                currentHistory.isSuspicious = false;
                if (player.isValid()) {
                    player.sendMessage("§a✅ Tu comportamiento ha vuelto a la normalidad.");
                }
            } catch (e) {
                console.warn("Error limpiando sospecha:", e);
            }
        }, 30000);
        
    } catch (error) {
        console.warn("Error manejando sospecha de movimiento:", error);
    }
}

// ========== PROTECCIÓN ANTI-RAID DE ENTIDADES HOSTILES ==========
system.runInterval(() => {
    try {
        const now = Date.now();
        const dimension = world.getDimension("overworld");
        if (!dimension) return;
        let totalHostiles = 0;
        let hostilesByType = {};
        for (const type of HOSTILE_MOBS) {
            const entities = dimension.getEntities({type});
            hostilesByType[type] = entities.length;
            totalHostiles += entities.length;
        }
        // Si hay más de 50 hostiles o más de 10 de un solo tipo
        if (totalHostiles > 50 || Object.values(hostilesByType).some(c => c > 10)) {
            for (const type of HOSTILE_MOBS) {
                try {
                    dimension.runCommand(`kill @e[type=${type}]`);
                } catch {}
            }
            world.sendMessage("§c⚠️ Raid de entidades hostiles detectado. Limpiando mobs y bloqueando spawn temporalmente.");
            hostileSpawnBlockedUntil = now + 60000; // 1 minuto
        }
    } catch (error) {
        console.warn("Error en protección anti-raid de entidades hostiles:", error);
    }
}, 40);

// Bloquear spawn de hostiles si está activo el bloqueo
world.beforeEvents.entitySpawn.subscribe((event) => {
    try {
        const now = Date.now();
        if (hostileSpawnBlockedUntil > now && HOSTILE_MOBS.includes(event.entity.typeId)) {
            event.cancel = true;
            event.entity.remove();
        }
    } catch (error) {
        console.warn("Error bloqueando spawn de hostiles:", error);
    }
});