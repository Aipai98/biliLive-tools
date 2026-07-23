import { TypedEmitter } from "tiny-typed-emitter";
import { isBetweenTimeRange } from "../../utils/index.js";
import { TaskType } from "../../enum.js";

import type { Status } from "@biliLive-tools/types";
import type { AppConfig } from "../../config.js";
import type { AbstractTask } from "./AbstractTask.js";
import type { TaskEvents } from "./types.js";

/**
 * 优先级串行控制器
 * - enabled：是否开启优先级串行模式（对应全局 task.prioritySerial）
 * - roomPriority：获取房间处理优先级，数字越小越优先
 * - recordingRooms：返回当前仍在录制的房间ID列表
 */
export interface PriorityController {
  enabled: () => boolean;
  roomPriority: (roomId: string) => number;
  recordingRooms: () => string[];
}

/**
 * 任务队列管理类
 */
export class TaskQueue {
  appConfig: AppConfig;
  queue: AbstractTask[];
  emitter = new TypedEmitter<TaskEvents>();
  on: TypedEmitter<TaskEvents>["on"];
  off: TypedEmitter<TaskEvents>["off"];
  /** 优先级串行控制器，由上层（webhook）注入 */
  priorityController?: PriorityController;

  constructor(appConfig: AppConfig) {
    this.queue = [];
    this.appConfig = appConfig;
    this.on = this.emitter.on.bind(this.emitter);
    this.off = this.emitter.off.bind(this.emitter);
    this.on("task-end", () => {
      this.addTaskForLimit();
    });
    this.on("task-error", () => {
      this.addTaskForLimit();
    });
    this.on("task-pause", () => {
      this.addTaskForLimit();
    });
    this.on("task-cancel", ({ autoStart }) => {
      if (autoStart) this.addTaskForLimit();
    });

    setInterval(() => {
      // @ts-ignore
      const isVitest = process.env.NODE_ENV === "test";
      if (isVitest) return;
      this.addTaskForLimit();
    }, 1000 * 60);
  }

  /**
   * 注入优先级串行控制器（由 webhook 层调用）
   */
  setPriorityController(controller: PriorityController): void {
    this.priorityController = controller;
  }

  private get priorityEnabled(): boolean {
    return !!this.priorityController && this.priorityController.enabled();
  }

  /**
   * 优先级串行模式下，返回当前应当被允许执行的房间ID。
   * - 未开启优先级串行 → 返回 null（不限制）
   * - 开启后：
   *   1. 活跃房间 = 队列中存在 pending/running 的 ffmpeg 任务的房间 ∪ 正在录制的房间
   *   2. 按优先级升序、roomId 升序排序，保证确定性
   *   3. 返回第一个“确实有待执行 ffmpeg 任务”的房间，
   *      避免“正在录制但暂无任务”的房间永久饿死其它房间
   * 返回 null 表示无需限制（如活跃房间全部暂无任务）。
   */
  private getAllowedRoom(): string | null {
    if (!this.priorityEnabled) return null;
    const controller = this.priorityController!;

    // 收集队列中存在 pending/running 的 ffmpeg 任务的房间（仅统计带 roomId 的任务）
    const roomsWithTasks = new Map<string, boolean>();
    for (const t of this.queue) {
      if (t.type !== TaskType.ffmpeg) continue;
      if (t.status !== "pending" && t.status !== "running") continue;
      const rid = t.extra?.roomId;
      if (rid != null) roomsWithTasks.set(String(rid), true);
    }

    const activeRooms = new Set<string>();
    for (const rid of roomsWithTasks.keys()) activeRooms.add(String(rid));
    for (const rid of controller.recordingRooms()) activeRooms.add(String(rid));
    if (activeRooms.size === 0) return null;

    const sorted = [...activeRooms].sort((a, b) => {
      const pa = controller.roomPriority(a);
      const pb = controller.roomPriority(b);
      if (pa !== pb) return pa - pb;
      return String(a).localeCompare(String(b));
    });

    for (const rid of sorted) {
      if (roomsWithTasks.has(rid)) return rid;
    }
    return null;
  }

  /**
   * 判断某个房间当前是否被更高优先级房间挡住（不允许执行）。
   * 没有 roomId 的任务（如 flvRepair）不受限制，始终允许。
   */
  private isRoomBlocked(roomId: string | number | undefined): boolean {
    if (!this.priorityEnabled) return false;
    if (roomId == null) return false;
    const allowed = this.getAllowedRoom();
    if (allowed == null) return false;
    return String(allowed) !== String(roomId);
  }

  /**
   * 运行任务，考虑任务限制和时间范围
   */
  runTask(task: AbstractTask): void {
    const typeMap: Record<string, string> = {
      [TaskType.ffmpeg]: "ffmpegMaxNum",
      [TaskType.douyuDownload]: "douyuDownloadMaxNum",
      [TaskType.biliUpload]: "biliUploadMaxNum",
      [TaskType.biliDownload]: "biliDownloadMaxNum",
      [TaskType.sync]: "syncMaxNum",
    };
    const config = this.appConfig.getAll();
    const maxNum = config?.task?.[typeMap[task.type]] ?? 0;
    // 优先级串行：ffmpeg 强制并发为 1（与 taskLimit 保持一致）
    const effectiveMax =
      task.type === TaskType.ffmpeg && this.priorityEnabled ? 1 : maxNum;

    // 优先级串行：ffmpeg 任务需是当前允许执行的房间，否则保持 pending
    if (task.type === TaskType.ffmpeg && this.isRoomBlocked(task.extra?.roomId)) {
      return;
    }

    if (effectiveMax >= 0) {
      this.filter({ type: task.type, status: "running" }).length < effectiveMax &&
        isBetweenTimeRange(task.limitTime) &&
        task.exec();
    } else {
      isBetweenTimeRange(task.limitTime) && task.exec();
    }
  }

  /**
   * 添加任务到队列
   * @param task 任务实例
   * @param autoRun 是否自动运行（true: 立即执行, false: 根据任务限制决定）
   */
  addTask(task: AbstractTask, autoRun = true): void {
    task.emitter.on("task-end", ({ taskId, data }) => {
      this.emitter.emit("task-end", { taskId, data });
    });
    task.emitter.on("task-error", ({ taskId, error }) => {
      this.emitter.emit("task-error", { taskId, error });
    });
    task.emitter.on("task-progress", ({ taskId }) => {
      this.emitter.emit("task-progress", { taskId });
    });
    task.emitter.on("task-start", ({ taskId }) => {
      this.emitter.emit("task-start", { taskId });
    });
    task.emitter.on("task-pause", ({ taskId }) => {
      this.emitter.emit("task-pause", { taskId });
    });
    task.emitter.on("task-resume", ({ taskId }) => {
      this.emitter.emit("task-resume", { taskId });
    });
    task.emitter.on("task-cancel", ({ taskId, autoStart }) => {
      this.emitter.emit("task-cancel", { taskId, autoStart });
    });
    // task.emitter.on("task-removed-queue", ({ taskId }) => {
    //   this.emitter.emit("task-removed-queue", { taskId });
    // });

    this.queue.push(task);

    if (autoRun) {
      // 优先级串行模式下，ffmpeg 任务即便 autoRun 也要经过统一守卫
      if (task.type === TaskType.ffmpeg && this.priorityEnabled) {
        this.runTask(task);
      } else {
        task.exec();
      }
    } else {
      this.runTask(task);
    }
  }

  /**
   * 查询任务
   */
  queryTask(taskId: string): AbstractTask | undefined {
    const task = this.queue.find((task) => task.taskId === taskId);
    return task;
  }

  /**
   * 将任务序列化为可传输对象
   */
  stringify(item: AbstractTask[]) {
    return item.map((task) => {
      return {
        pid: task.pid,
        taskId: task.taskId,
        status: task.status,
        name: task.name,
        type: task.type,
        relTaskId: task.relTaskId,
        output: task.output,
        progress: task.progress,
        action: task.action,
        startTime: task.startTime,
        endTime: task.endTime,
        custsomProgressMsg: task.custsomProgressMsg,
        error: task.error ? String(task.error) : "",
        duration: task.getDuration(),
        extra: task.extra,
      };
    });
  }

  /**
   * 过滤任务
   */
  filter(options: { type?: string; status?: Status }): AbstractTask[] {
    return this.queue.filter((task) => {
      if (options.type && task.type !== options.type) return false;
      if (options.status && task.status !== options.status) return false;
      return true;
    });
  }

  /**
   * 获取所有任务
   */
  list(): AbstractTask[] {
    return this.queue;
  }

  /**
   * 启动任务
   */
  start(taskId: string): void {
    const task = this.queryTask(taskId);
    if (!task) return;
    if (task.status !== "pending") return;
    task.exec();
  }

  /**
   * 移除任务
   */
  remove(taskId: string): void {
    const task = this.queryTask(taskId);
    if (!task) return;
    task.emit("task-removed-queue", { taskId: task.taskId });
    const index = this.queue.indexOf(task);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }
  }

  /**
   * 暂停任务
   */
  pause(taskId: string): void {
    const task = this.queryTask(taskId);
    if (!task) return;
    task.pause();
    task.pauseStartTime = Date.now();
  }

  /**
   * 恢复任务
   */
  resume(taskId: string): void {
    const task = this.queryTask(taskId);
    if (!task) return;
    task.resume();
    // if (task.pauseStartTime !== null) {
    //   task.totalPausedDuration += Date.now() - task.pauseStartTime;
    //   task.pauseStartTime = null;
    // }
  }

  /**
   * 取消任务
   */
  cancel(taskId: string): void {
    const task = this.queryTask(taskId);
    if (!task) return;
    task.kill();
  }

  /**
   * 重启任务
   */
  restart(taskId: string): void {
    const task = this.queryTask(taskId);
    if (!task) return;
    if (task.action.includes("restart")) {
      // @ts-ignore
      task.restart();
    }
  }

  /**
   * 中断任务
   */
  interrupt(taskId: string): void {
    const task = this.queryTask(taskId);
    if (!task) return;
    if (task.action.includes("interrupt")) {
      // @ts-ignore
      return task.interrupt();
    }
    return;
  }

  /**
   * 根据任务类型限制并发数
   */
  private taskLimit(maxNum: number, type: string): void {
    const pendingFFmpegTask = this.filter({ type: type, status: "pending" }).filter((task) => {
      return isBetweenTimeRange(task.limitTime);
    });

    // 优先级串行：ffmpeg 强制串行（并发=1），只放行当前允许房间的任务
    if (type === TaskType.ffmpeg && this.priorityEnabled) {
      const allowed = this.getAllowedRoom();
      const allowedSet = allowed != null ? new Set([String(allowed)]) : null;
      const runningCount = this.filter({ type: type, status: "running" }).length;
      if (runningCount < 1) {
        const allowedPending = pendingFFmpegTask.filter((task) => {
          // 没有 roomId 的任务（如 flvRepair）不受限制，始终允许
          if (task.extra?.roomId == null) return true;
          if (!allowedSet) return true;
          return allowedSet.has(String(task.extra.roomId));
        });
        if (allowedPending.length > 0) {
          allowedPending[0].exec();
        }
      }
      return;
    }

    if (maxNum !== -1) {
      const runningTaskCount = this.filter({
        type: type,
        status: "running",
      }).length;

      if (runningTaskCount < maxNum) {
        pendingFFmpegTask.slice(0, maxNum - runningTaskCount).forEach((task) => {
          task.exec();
        });
      }
    } else {
      // TODO: 补充单元测试
      pendingFFmpegTask.forEach((task) => {
        task.exec();
      });
    }
  }

  /**
   * 根据配置限制各类型任务的并发数
   */
  private addTaskForLimit = (): void => {
    const config = this.appConfig.getAll();

    // ffmpeg任务
    this.taskLimit(config?.task?.ffmpegMaxNum ?? -1, TaskType.ffmpeg);
    // 斗鱼录播下载任务
    this.taskLimit(config?.task?.douyuDownloadMaxNum ?? -1, TaskType.douyuDownload);
    // B站上传任务
    this.taskLimit(config?.task?.biliUploadMaxNum ?? -1, TaskType.biliUpload);
    // B站下载任务
    this.taskLimit(config?.task?.biliDownloadMaxNum ?? -1, TaskType.biliDownload);
    // 同步任务
    this.taskLimit(config?.task?.syncMaxNum ?? 3, TaskType.sync);
  };
}
