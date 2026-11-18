// store.js — 数据层入口：按 SLENK_DATA_BACKEND 选择后端，导出接口一致。
//
//   local（默认，未设置时）→ store.local.js：数据直接存本地 JSON 文件（storage/local/），不用 MySQL
//   mysql                  → store.mysql.js：业务数据存 MySQL
//
// routes / worker / auth / lib 等一律 `import { ... } from './store.js'`，切换后端零改动。
import './loadEnv.js';
import * as mysqlImpl from './store.mysql.js';
import * as localImpl from './store.local.js';

const impl = process.env.SLENK_DATA_BACKEND === 'mysql' ? mysqlImpl : localImpl;

export const ensureAdmin = impl.ensureAdmin;
export const findUserByUsername = impl.findUserByUsername;
export const findUserById = impl.findUserById;
export const createUser = impl.createUser;
export const listUsers = impl.listUsers;
export const updateUser = impl.updateUser;
export const deleteUser = impl.deleteUser;

export const addTask = impl.addTask;
export const listTasks = impl.listTasks;
export const countTasksByType = impl.countTasksByType;
export const listAllTasks = impl.listAllTasks;
export const getTask = impl.getTask;
export const getTaskById = impl.getTaskById;
export const updateTask = impl.updateTask;
export const deleteTask = impl.deleteTask;
export const deleteTaskById = impl.deleteTaskById;
export const deleteTasksByIds = impl.deleteTasksByIds;

export const listProviders = impl.listProviders;
export const getProviderById = impl.getProviderById;
export const getProviderUnmaskedById = impl.getProviderUnmaskedById;
export const getActiveProvider = impl.getActiveProvider;
export const addProvider = impl.addProvider;
export const updateProvider = impl.updateProvider;
export const deleteProvider = impl.deleteProvider;
export const setActiveProvider = impl.setActiveProvider;
export const getActiveProviderIds = impl.getActiveProviderIds;

export const saveNote = impl.saveNote;
export const getNote = impl.getNote;

export const insertMedia = impl.insertMedia;
export const getMedia = impl.getMedia;

export const listXhsAccounts = impl.listXhsAccounts;
export const getXhsAccount = impl.getXhsAccount;
export const createXhsAccountPending = impl.createXhsAccountPending;
export const bindXhsAccountOpenId = impl.bindXhsAccountOpenId;
export const findXhsAccountByOpenId = impl.findXhsAccountByOpenId;
export const deleteXhsAccount = impl.deleteXhsAccount;
export const updateXhsAccountNickname = impl.updateXhsAccountNickname;
export const listAllXhsAccounts = impl.listAllXhsAccounts;

export const getAllNotesImagesForJanitor = impl.getAllNotesImagesForJanitor;
export const getAllTasksPayloadForJanitor = impl.getAllTasksPayloadForJanitor;
