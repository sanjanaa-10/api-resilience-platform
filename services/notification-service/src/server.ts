import { createSimulationApp } from '../../shared/src/app/createSimulationApp';
import { startSimulationServer } from '../../shared/src/server/startServer';
import { notificationServiceDefinition } from './config/service.config';

const { app } = createSimulationApp(notificationServiceDefinition);
startSimulationServer(app, notificationServiceDefinition);
