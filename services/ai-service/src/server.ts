import { createSimulationApp } from '../../shared/src/app/createSimulationApp';
import { startSimulationServer } from '../../shared/src/server/startServer';
import { aiServiceDefinition } from './config/service.config';

const { app } = createSimulationApp(aiServiceDefinition);
startSimulationServer(app, aiServiceDefinition);
