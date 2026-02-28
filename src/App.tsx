/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Play, RotateCcw, Trophy, Timer, Gauge, ChevronLeft, ChevronRight } from 'lucide-react';

// --- Constants & Types ---

const ROAD_WIDTH = 2000;
const SEGMENT_LENGTH = 200;
const RUMBLE_LENGTH = 3;
const LANES = 3;
const DRAW_DISTANCE = 300;
const CAMERA_HEIGHT = 1000;
const CAMERA_DEPTH = 0.8; // z-depth of camera
const FOG_DENSITY = 5;
const MAX_SPEED = SEGMENT_LENGTH / (1 / 60); // segments per second
const ACCEL = MAX_SPEED / 5;
const BREAKING = -MAX_SPEED;
const DECEL = -MAX_SPEED / 5;
const OFF_ROAD_DECEL = -MAX_SPEED / 2;
const OFF_ROAD_LIMIT = MAX_SPEED / 4;

type ColorSet = {
  road: string;
  grass: string;
  rumble: string;
  lane?: string;
};

const COLORS = {
  LIGHT: { road: '#6B7280', grass: '#10B981', rumble: '#F9FAFB', lane: '#F9FAFB' },
  DARK: { road: '#4B5563', grass: '#059669', rumble: '#111827' },
  START: { road: '#FFFFFF', grass: '#FFFFFF', rumble: '#FFFFFF' },
  FINISH: { road: '#000000', grass: '#000000', rumble: '#000000' },
};

type Point = { x: number; y: number; z: number; screenX: number; screenY: number; screenW: number };
type Segment = {
  index: number;
  p1: Point;
  p2: Point;
  curve: number;
  sprites: Sprite[];
  color: ColorSet;
};

type Sprite = {
  source: string;
  x: number; // -1 to 1 (offset from center)
  w: number;
  h: number;
  type: 'obstacle' | 'prop' | 'boost';
};

type GameState = 'START' | 'PLAYING' | 'FINISHED' | 'GAMEOVER';

// --- Utils ---

const project = (p: Point, cameraX: number, cameraY: number, cameraZ: number, width: number, height: number, roadWidth: number) => {
  const worldX = p.x - cameraX;
  const worldY = p.y - cameraY;
  const worldZ = p.z - cameraZ;
  const scale = CAMERA_DEPTH / worldZ;

  p.screenX = Math.round((width / 2) + (scale * worldX * width / 2));
  p.screenY = Math.round((height / 2) - (scale * worldY * height / 2));
  p.screenW = Math.round(scale * roadWidth * width / 2);
};

const drawPolygon = (ctx: CanvasRenderingContext2D, x1: number, y1: number, w1: number, x2: number, y2: number, w2: number, color: string) => {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1 - w1, y1);
  ctx.lineTo(x2 - w2, y2);
  ctx.lineTo(x2 + w2, y2);
  ctx.lineTo(x1 + w1, y1);
  ctx.closePath();
  ctx.fill();
};

const drawSprite = (ctx: CanvasRenderingContext2D, width: number, height: number, roadWidth: number, segment: Segment, sprite: Sprite, destX: number) => {
  const scale = segment.p1.screenW / roadWidth;
  const destY = segment.p1.screenY;
  const destW = (sprite.w * scale * width / 2);
  const destH = (sprite.h * scale * width / 2);

  const x = destX + (destW * sprite.x);
  const y = destY - destH;

  // Simple shapes instead of images for "Cartoon 3D" look
  if (sprite.type === 'obstacle') {
    ctx.fillStyle = '#4B5563'; // Stone color
    ctx.beginPath();
    ctx.ellipse(x + destW / 2, y + destH / 2, destW / 2, destH / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1F2937';
    ctx.lineWidth = 2;
    ctx.stroke();
  } else if (sprite.type === 'boost') {
    ctx.fillStyle = '#FBBF24'; // Gold/Yellow
    ctx.beginPath();
    ctx.arc(x + destW / 2, y + destH / 2, destW / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#D97706';
    ctx.stroke();
  } else {
    ctx.fillStyle = '#065F46'; // Tree
    ctx.beginPath();
    ctx.moveTo(x + destW / 2, y);
    ctx.lineTo(x, y + destH);
    ctx.lineTo(x + destW, y + destH);
    ctx.closePath();
    ctx.fill();
  }
};

// --- Main Component ---

export default function App() {
  const [gameState, setGameState] = useState<GameState>('START');
  const [score, setScore] = useState(0);
  const [time, setTime] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [distance, setDistance] = useState(0);
  const [bestTime, setBestTime] = useState<number | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(null);
  const gameRef = useRef({
    position: 0,
    playerX: 0,
    playerZ: 0,
    speed: 0,
    trackLength: 0,
    segments: [] as Segment[],
    startTime: 0,
    boostTimer: 0,
  });

  // --- Track Generation ---

  const resetTrack = useCallback(() => {
    const segments: Segment[] = [];
    const totalSegments = 500;

    for (let n = 0; n < totalSegments; n++) {
      const isFinish = n > totalSegments - 10;
      const isStart = n < 10;
      
      segments.push({
        index: n,
        p1: { x: 0, y: 0, z: n * SEGMENT_LENGTH, screenX: 0, screenY: 0, screenW: 0 },
        p2: { x: 0, y: 0, z: (n + 1) * SEGMENT_LENGTH, screenX: 0, screenY: 0, screenW: 0 },
        curve: n > 100 && n < 200 ? 2 : (n > 300 && n < 400 ? -2 : 0),
        sprites: [],
        color: isFinish ? COLORS.FINISH : (isStart ? COLORS.START : (Math.floor(n / RUMBLE_LENGTH) % 2 ? COLORS.DARK : COLORS.LIGHT)),
      });

      // Add obstacles/props
      if (n > 20 && !isFinish) {
        if (n % 20 === 0) {
          segments[n].sprites.push({
            source: '',
            x: (Math.random() * 2 - 1) * 0.8,
            w: 100,
            h: 100,
            type: 'obstacle'
          });
        }
        if (n % 50 === 0) {
          segments[n].sprites.push({
            source: '',
            x: (Math.random() * 2 - 1) * 0.5,
            w: 80,
            h: 80,
            type: 'boost'
          });
        }
        // Trees on the side
        if (n % 5 === 0) {
          segments[n].sprites.push({
            source: '',
            x: -1.5 - Math.random() * 2,
            w: 150,
            h: 300,
            type: 'prop'
          });
          segments[n].sprites.push({
            source: '',
            x: 1.5 + Math.random() * 2,
            w: 150,
            h: 300,
            type: 'prop'
          });
        }
      }
    }

    gameRef.current.segments = segments;
    gameRef.current.trackLength = segments.length * SEGMENT_LENGTH;
    gameRef.current.position = 0;
    gameRef.current.playerX = 0;
    gameRef.current.speed = 0;
    gameRef.current.boostTimer = 0;
  }, []);

  // --- Game Loop ---

  const update = useCallback((dt: number) => {
    const game = gameRef.current;
    if (gameState !== 'PLAYING') return;

    // Handle Input (simplified for this demo, usually would use key listeners or touch state)
    // Here we'll assume automatic acceleration and external steering via state/refs
    
    const targetSpeed = game.boostTimer > 0 ? MAX_SPEED * 1.5 : MAX_SPEED;
    game.speed = Math.min(game.speed + ACCEL * dt, targetSpeed);

    // Off-road penalty
    if (Math.abs(game.playerX) > 1) {
      if (game.speed > OFF_ROAD_LIMIT) {
        game.speed += OFF_ROAD_DECEL * dt;
      }
    }

    game.position += game.speed * dt;
    if (game.position >= game.trackLength) {
      setGameState('FINISHED');
      const finalTime = (Date.now() - game.startTime) / 1000;
      if (!bestTime || finalTime < bestTime) setBestTime(finalTime);
    }

    // Collision Detection
    const currentSegment = game.segments[Math.floor(game.position / SEGMENT_LENGTH) % game.segments.length];
    currentSegment.sprites.forEach(sprite => {
      if (sprite.type === 'obstacle' || sprite.type === 'boost') {
        const spriteW = sprite.w / ROAD_WIDTH;
        if (Math.abs(game.playerX - sprite.x) < spriteW) {
          if (sprite.type === 'obstacle') {
            game.speed *= 0.5;
            // Remove sprite so we don't hit it again immediately
            currentSegment.sprites = currentSegment.sprites.filter(s => s !== sprite);
          } else if (sprite.type === 'boost') {
            game.boostTimer = 3; // 3 seconds boost
            currentSegment.sprites = currentSegment.sprites.filter(s => s !== sprite);
          }
        }
      }
    });

    if (game.boostTimer > 0) game.boostTimer -= dt;

    // Update UI state
    setSpeed(Math.round(game.speed / 10));
    setDistance(Math.round((game.position / game.trackLength) * 100));
    setTime(Math.round((Date.now() - game.startTime) / 100) / 10);
  }, [gameState, bestTime]);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = canvas;
    const game = gameRef.current;

    ctx.clearRect(0, 0, width, height);

    // Draw Sky
    const skyGradient = ctx.createLinearGradient(0, 0, 0, height / 2);
    skyGradient.addColorStop(0, '#60A5FA');
    skyGradient.addColorStop(1, '#BFDBFE');
    ctx.fillStyle = skyGradient;
    ctx.fillRect(0, 0, width, height / 2);

    // Draw Ground
    ctx.fillStyle = '#10B981';
    ctx.fillRect(0, height / 2, width, height / 2);

    const baseSegment = game.segments[Math.floor(game.position / SEGMENT_LENGTH) % game.segments.length];
    const basePercent = (game.position % SEGMENT_LENGTH) / SEGMENT_LENGTH;
    
    let x = 0;
    let dx = -(baseSegment.curve * basePercent);

    // Projection
    for (let n = 0; n < DRAW_DISTANCE; n++) {
      const segment = game.segments[(baseSegment.index + n) % game.segments.length];
      const looped = segment.index < baseSegment.index;
      
      project(segment.p1, game.playerX * ROAD_WIDTH - x, CAMERA_HEIGHT, game.position - (looped ? game.trackLength : 0), width, height, ROAD_WIDTH);
      project(segment.p2, game.playerX * ROAD_WIDTH - x - dx, CAMERA_HEIGHT, game.position - (looped ? game.trackLength : 0), width, height, ROAD_WIDTH);

      x += dx;
      dx += segment.curve;

      if (segment.p1.z <= game.position || segment.p2.screenY >= segment.p1.screenY) continue;

      // Draw Grass
      ctx.fillStyle = segment.color.grass;
      ctx.fillRect(0, segment.p2.screenY, width, segment.p1.screenY - segment.p2.screenY);

      // Draw Road
      drawPolygon(ctx, segment.p1.screenX, segment.p1.screenY, segment.p1.screenW, segment.p2.screenX, segment.p2.screenY, segment.p2.screenW, segment.color.road);

      // Draw Rumble
      const rumbleW1 = segment.p1.screenW * 0.1;
      const rumbleW2 = segment.p2.screenW * 0.1;
      drawPolygon(ctx, segment.p1.screenX - segment.p1.screenW - rumbleW1, segment.p1.screenY, rumbleW1, segment.p2.screenX - segment.p2.screenW - rumbleW2, segment.p2.screenY, rumbleW2, segment.color.rumble);
      drawPolygon(ctx, segment.p1.screenX + segment.p1.screenW + rumbleW1, segment.p1.screenY, rumbleW1, segment.p2.screenX + segment.p2.screenW + rumbleW2, segment.p2.screenY, rumbleW2, segment.color.rumble);

      // Draw Lanes
      if (segment.color.lane) {
        const laneW1 = segment.p1.screenW * 0.02;
        const laneW2 = segment.p2.screenW * 0.02;
        drawPolygon(ctx, segment.p1.screenX, segment.p1.screenY, laneW1, segment.p2.screenX, segment.p2.screenY, laneW2, segment.color.lane);
      }
    }

    // Draw Sprites (Back to Front)
    for (let n = DRAW_DISTANCE - 1; n > 0; n--) {
      const segment = game.segments[(baseSegment.index + n) % game.segments.length];
      segment.sprites.forEach(sprite => {
        drawSprite(ctx, width, height, ROAD_WIDTH, segment, sprite, segment.p1.screenX);
      });
    }

    // Draw Player Car (Static in center, but with slight tilt)
    const carW = 120;
    const carH = 60;
    const carX = width / 2 - carW / 2;
    const carY = height - 120;
    
    // Simple Cartoon Car
    ctx.save();
    // Tilt based on curve/steering
    const tilt = (game.speed > 0 ? (gameRef.current.playerX * 0.1) : 0);
    ctx.translate(width / 2, carY + carH / 2);
    ctx.rotate(tilt);
    ctx.translate(-width / 2, -(carY + carH / 2));

    // Body
    ctx.fillStyle = game.boostTimer > 0 ? '#F59E0B' : '#EF4444';
    ctx.beginPath();
    ctx.roundRect(carX, carY, carW, carH, 10);
    ctx.fill();
    ctx.strokeStyle = '#991B1B';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Roof
    ctx.fillStyle = '#FEE2E2';
    ctx.beginPath();
    ctx.roundRect(carX + 20, carY - 20, carW - 40, 30, 5);
    ctx.fill();
    ctx.stroke();

    // Wheels
    ctx.fillStyle = '#1F2937';
    ctx.fillRect(carX - 5, carY + 10, 10, 20);
    ctx.fillRect(carX + carW - 5, carY + 10, 10, 20);
    ctx.fillRect(carX - 5, carY + carH - 30, 10, 20);
    ctx.fillRect(carX + carW - 5, carY + carH - 30, 10, 20);

    ctx.restore();

  }, []);

  const loop = useCallback((time: number) => {
    if (lastTime.current !== undefined) {
      const dt = Math.min(1, (time - lastTime.current) / 1000);
      update(dt);
      render();
    }
    lastTime.current = time;
    requestRef.current = requestAnimationFrame(loop);
  }, [update, render]);

  const lastTime = useRef<number>(undefined);

  useEffect(() => {
    resetTrack();
    requestRef.current = requestAnimationFrame(loop);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [loop, resetTrack]);

  // --- Handlers ---

  const startGame = () => {
    resetTrack();
    gameRef.current.startTime = Date.now();
    setGameState('PLAYING');
  };

  const handleSteer = (dir: number) => {
    if (gameState !== 'PLAYING') return;
    const game = gameRef.current;
    const steerAmount = 0.05 * (game.speed / MAX_SPEED);
    game.playerX = Math.max(-2, Math.min(2, game.playerX + dir * steerAmount));
  };

  // --- UI Components ---

  return (
    <div className="relative w-full h-screen bg-slate-900 overflow-hidden font-sans select-none touch-none">
      {/* Game Canvas */}
      <canvas
        ref={canvasRef}
        width={800}
        height={600}
        className="w-full h-full object-cover"
      />

      {/* HUD */}
      {gameState === 'PLAYING' && (
        <div className="absolute top-0 left-0 w-full p-6 flex justify-between items-start pointer-events-none">
          <div className="flex flex-col gap-2">
            <div className="bg-black/40 backdrop-blur-md border border-white/10 rounded-2xl p-4 flex items-center gap-4 text-white shadow-xl">
              <div className="p-2 bg-emerald-500/20 rounded-lg">
                <Gauge className="w-6 h-6 text-emerald-400" />
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider opacity-60">Speed</p>
                <p className="text-2xl font-bold tabular-nums">{speed} <span className="text-xs font-normal opacity-60">KM/H</span></p>
              </div>
            </div>
            <div className="bg-black/40 backdrop-blur-md border border-white/10 rounded-2xl p-4 flex items-center gap-4 text-white shadow-xl">
              <div className="p-2 bg-blue-500/20 rounded-lg">
                <Timer className="w-6 h-6 text-blue-400" />
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider opacity-60">Time</p>
                <p className="text-2xl font-bold tabular-nums">{time.toFixed(1)}s</p>
              </div>
            </div>
          </div>

          <div className="bg-black/40 backdrop-blur-md border border-white/10 rounded-2xl p-4 text-white shadow-xl min-w-[120px]">
            <p className="text-[10px] uppercase tracking-wider opacity-60 mb-1">Progress</p>
            <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
              <motion.div 
                className="h-full bg-emerald-500"
                initial={{ width: 0 }}
                animate={{ width: `${distance}%` }}
              />
            </div>
            <p className="text-right text-xs mt-1 opacity-80">{distance}%</p>
          </div>
        </div>
      )}

      {/* Controls Overlay (Invisible touch areas) */}
      {gameState === 'PLAYING' && (
        <div className="absolute inset-0 flex">
          <div 
            className="flex-1 active:bg-white/5 transition-colors flex items-center justify-start p-8"
            onPointerDown={() => {
              const interval = setInterval(() => handleSteer(-1), 16);
              const cleanup = () => {
                clearInterval(interval);
                window.removeEventListener('pointerup', cleanup);
              };
              window.addEventListener('pointerup', cleanup);
            }}
          >
            <ChevronLeft className="w-12 h-12 text-white/20" />
          </div>
          <div 
            className="flex-1 active:bg-white/5 transition-colors flex items-center justify-end p-8"
            onPointerDown={() => {
              const interval = setInterval(() => handleSteer(1), 16);
              const cleanup = () => {
                clearInterval(interval);
                window.removeEventListener('pointerup', cleanup);
              };
              window.addEventListener('pointerup', cleanup);
            }}
          >
            <ChevronRight className="w-12 h-12 text-white/20" />
          </div>
        </div>
      )}

      {/* Screens */}
      <AnimatePresence>
        {gameState === 'START' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-slate-900/80 backdrop-blur-xl flex flex-col items-center justify-center p-6 text-center"
          >
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.2 }}
              className="mb-12"
            >
              <h1 className="text-6xl font-black text-white mb-4 tracking-tighter uppercase italic">
                极简赛车 <span className="text-emerald-500">3D</span>
              </h1>
              <p className="text-slate-400 max-w-xs mx-auto">
                左右滑动控制赛车，躲避障碍，冲向终点！
              </p>
            </motion.div>

            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={startGame}
              className="group relative flex items-center gap-4 bg-emerald-500 hover:bg-emerald-400 text-slate-900 px-12 py-6 rounded-full font-black text-2xl shadow-[0_0_40px_rgba(16,185,129,0.3)] transition-all"
            >
              <Play className="w-8 h-8 fill-current" />
              开始游戏
            </motion.button>

            {bestTime && (
              <p className="mt-8 text-slate-500 font-mono text-sm">
                最佳纪录: {bestTime.toFixed(2)}s
              </p>
            )}
          </motion.div>
        )}

        {gameState === 'FINISHED' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-emerald-500 flex flex-col items-center justify-center p-6 text-center text-slate-900"
          >
            <motion.div
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white p-12 rounded-[3rem] shadow-2xl max-w-sm w-full"
            >
              <Trophy className="w-24 h-24 mx-auto mb-6 text-yellow-500" />
              <h2 className="text-4xl font-black mb-2 uppercase italic">挑战成功!</h2>
              <div className="my-8 space-y-4">
                <div className="flex justify-between items-center border-b border-slate-100 pb-2">
                  <span className="text-slate-500 uppercase text-xs font-bold tracking-widest">本次用时</span>
                  <span className="text-2xl font-black font-mono">{time.toFixed(2)}s</span>
                </div>
                {bestTime && (
                  <div className="flex justify-between items-center">
                    <span className="text-slate-500 uppercase text-xs font-bold tracking-widest">最佳纪录</span>
                    <span className="text-xl font-bold font-mono text-emerald-600">{bestTime.toFixed(2)}s</span>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-3">
                <button
                  onClick={startGame}
                  className="flex items-center justify-center gap-3 bg-slate-900 text-white py-4 rounded-2xl font-bold hover:bg-slate-800 transition-colors"
                >
                  <RotateCcw className="w-5 h-5" />
                  再来一局
                </button>
                <button
                  onClick={() => setGameState('START')}
                  className="text-slate-400 font-bold text-sm hover:text-slate-600"
                >
                  返回主菜单
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mobile Hint */}
      {gameState === 'PLAYING' && distance < 5 && (
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="absolute bottom-24 left-1/2 -translate-x-1/2 bg-black/60 backdrop-blur-md text-white px-6 py-3 rounded-full text-sm font-medium border border-white/10"
        >
          点击屏幕两侧控制转向
        </motion.div>
      )}
    </div>
  );
}
