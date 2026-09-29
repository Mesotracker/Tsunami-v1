import { SimulationEngine } from "../src/core/SimulationEngine";
import { buildScenario } from "../src/data/scenarios";
for (const id of ["subduction","openocean","explosion","island","bay","citycoast","lab"]) {
  const sc = buildScenario(id);
  sc.world.physicsRes = 128; sc.world.terrainRes=192; 
  const e = new SimulationEngine(sc.world, sc.physics, sc.terrain, sc.source);
  e.instruments = sc.instruments.map(i=>({...i,series:[]}));
  e.cities = sc.cities;
  e.armSource();
  e.resetSimulation();
  const t0=Date.now();
  while (e.solver.time < 600) e.advance(5, 500);
  e.updateStats();
  const ts=Date.now()-t0;
  console.log(id.padEnd(11), "t=",e.solver.time.toFixed(0), "maxWave=",e.stats.maxWaveHeight.toFixed(2),
    "maxV=",e.stats.maxVelocity.toFixed(2), "inund km2=",(e.stats.maxInundationArea/1e6).toFixed(1),
    "penet km=",(e.stats.maxInundationDistance/1000).toFixed(1),
    "volErr%=",(e.stats.volumeError/e.solver.initialVolume*100).toExponential(1),
    "events=",e.events.length, "cps=",e.checkpoints.length, "ms=",ts);
  // seek test
  const st=Date.now();
  e.seek(200);
  console.log("   seek->200 gave", e.solver.time.toFixed(1), "in", Date.now()-st,"ms; statUpd ok");
  const u0=Date.now(); e.updateStats(); console.log("   updateStats ms",Date.now()-u0);
}
