import { createSimulationApp } from '../../shared/src/app/createSimulationApp';
import { startSimulationServer } from '../../shared/src/server/startServer';
import { aiFallbackServiceDefinition } from './config/service.config';

const { app } = createSimulationApp(aiFallbackServiceDefinition);
startSimulationServer(app, aiFallbackServiceDefinition);
