import { createSimulationApp } from '../../shared/src/app/createSimulationApp';
import { startSimulationServer } from '../../shared/src/server/startServer';
import { paymentServiceDefinition } from './config/service.config';

const { app } = createSimulationApp(paymentServiceDefinition);
startSimulationServer(app, paymentServiceDefinition);
