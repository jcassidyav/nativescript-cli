import * as path from "path";
import { PlistSession } from "plist-merge-patch";
import { IPluginsService, IPluginData } from "../definitions/plugins";
import { IProjectData } from "../definitions/project";
import { IFileSystem } from "../common/declarations";
import { IOptions } from "../declarations";
import { injector } from "../common/yok";

export class IOSEntitlementsService {
	constructor(
		private $options: IOptions,
		private $fs: IFileSystem,
		private $logger: ILogger,
		private $devicePlatformsConstants: Mobile.IDevicePlatformsConstants,
		private $mobileHelper: Mobile.IMobileHelper,
		private $pluginsService: IPluginsService
	) {}

	public static readonly DefaultEntitlementsName: string = "app.entitlements";

	private getDefaultAppEntitlementsPath(projectData: IProjectData): string {
		const entitlementsName = IOSEntitlementsService.DefaultEntitlementsName;
		const entitlementsPath = path.join(
			projectData.appResourcesDirectoryPath,
			this.$mobileHelper.normalizePlatformName(
				this.$options.platformOverride ?? this.$devicePlatformsConstants.iOS
			),
			entitlementsName
		);
		return entitlementsPath;
	}

	public getPlatformsEntitlementsPath(projectData: IProjectData): string {
		return path.join(
			projectData.platformsDir,
			this.$options.platformOverride ??
				this.$devicePlatformsConstants.iOS.toLowerCase(),
			projectData.projectName,
			projectData.projectName + ".entitlements"
		);
	}
	public getPlatformsEntitlementsRelativePath(
		projectData: IProjectData
	): string {
		return path.join(
			projectData.projectName,
			projectData.projectName + ".entitlements"
		);
	}

	public async merge(projectData: IProjectData): Promise<void> {
		const session = new PlistSession({
			log: (txt: string) => this.$logger.trace("App.entitlements: " + txt),
		});

		const projectDir = projectData.projectDir;
		const makePatch = (plistPath: string) => {
			if (!this.$fs.exists(plistPath)) {
				this.$logger.trace("No plist found at: " + plistPath);
				return;
			}

			this.$logger.trace("Schedule merge plist at: " + plistPath);
			session.patch({
				name: path.relative(projectDir, plistPath),
				read: () => this.$fs.readText(plistPath),
			});
		};

		const allPlugins = await this.getAllInstalledPlugins(projectData);
		for (const plugin of allPlugins) {
			const pluginInfoPlistPath = path.join(
				plugin.pluginPlatformsFolderPath(this.$devicePlatformsConstants.iOS),
				IOSEntitlementsService.DefaultEntitlementsName
			);
			makePatch(pluginInfoPlistPath);
		}

		const appEntitlementsPath = this.getDefaultAppEntitlementsPath(projectData);
		if (this.$fs.exists(appEntitlementsPath)) {
			makePatch(appEntitlementsPath);
		}

		if ((<any>session).patches && (<any>session).patches.length > 0) {
			const plistContent = session.build();
			this.$logger.trace(
				"App.entitlements: Write to: " +
					this.getPlatformsEntitlementsPath(projectData)
			);
			this.$fs.writeFile(
				this.getPlatformsEntitlementsPath(projectData),
				plistContent
			);
		}
	}

	private getAllInstalledPlugins(
		projectData: IProjectData
	): Promise<IPluginData[]> {
		return this.$pluginsService.getAllInstalledPlugins(projectData);
	}
}

injector.register("iOSEntitlementsService", IOSEntitlementsService);
