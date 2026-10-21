import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AlloyalCategoriesCacheService } from 'src/beneficios/services/alloyal-categories-cache.service';
import { isTenantBase, TENANT } from 'src/config/tenant.config';
import { AppDirectPartnersQuery } from 'src/direct-partners/dto/app-direct-partners.query';
import { CreateDirectPartnerCouponDto } from 'src/direct-partners/dto/create-direct-partner-coupon.dto';
import { CreateDirectPartnerDto } from 'src/direct-partners/dto/create-direct-partner.dto';
import { ListDirectPartnersQuery } from 'src/direct-partners/dto/list-direct-partners.query';
import { UpdateDirectPartnerCouponDto } from 'src/direct-partners/dto/update-direct-partner-coupon.dto';
import { UpdateDirectPartnerDto } from 'src/direct-partners/dto/update-direct-partner.dto';
import {
  DIRECT_PARTNER_BASE_LABELS,
  DIRECT_PARTNER_CATEGORY_LABELS,
  DIRECT_PARTNER_TONE_LABELS,
  DirectPartnerCategory,
  DirectPartnerTone,
  State,
} from 'src/direct-partners/enums/direct-partner.enums';
import {
  lerAlloyalCategoryIds,
  normalizarCodigoCupom,
  parseDataCupom,
  validarHorarios,
} from 'src/direct-partners/helpers/direct-partner.helpers';
import {
  Coordenadas,
  DirectPartnerAdmin,
  DirectPartnerAppDetail,
  DirectPartnerAppListItem,
  DirectPartnerCouponAdmin,
  toAdmin,
  toAdminCoupon,
  toAppDetail,
  toAppListItem,
} from 'src/direct-partners/mappers/direct-partner.mapper';
import {
  DirectPartnersRepository,
  PartnerAdminRecord,
} from 'src/direct-partners/repositories/direct-partners.repository';
import { FileUploadService } from 'src/infra/storage/file-upload.service';

/** Erros com `code` (§7). O `HttpExceptionFilter` devolve o objeto como veio. */
function erro422(code: string, message: string): UnprocessableEntityException {
  return new UnprocessableEntityException({ statusCode: 422, code, message });
}

function erro409(
  code: string,
  message: string,
  extra?: object,
): ConflictException {
  return new ConflictException({ statusCode: 409, code, message, ...extra });
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value.toLowerCase() === 'true';
}

/**
 * Regras de negócio dos parceiros diretos (§4): CRUD do painel, leitura do
 * app por base e derivações (iniciais, melhor benefício, aberto agora).
 * O resgate de cupom fica em `DirectPartnerRedemptionsService`.
 */
@Injectable()
export class DirectPartnersService {
  private readonly logger = new Logger(DirectPartnersService.name);

  constructor(
    private readonly repository: DirectPartnersRepository,
    private readonly fileUploadService: FileUploadService,
    private readonly alloyalCategoriesCache: AlloyalCategoriesCacheService,
  ) {}

  // ------------------------------------------------------------ opções §5.0

  async opcoes() {
    const bases = TENANT.baseNames;
    return {
      bases: bases.map((value) => ({
        value,
        label: DIRECT_PARTNER_BASE_LABELS[value] ?? this.rotuloBase(value),
      })),
      categorias: Object.values(DirectPartnerCategory).map((value) => ({
        value,
        label: DIRECT_PARTNER_CATEGORY_LABELS[value],
      })),
      tons: Object.values(DirectPartnerTone).map((value) => ({
        value,
        label: DIRECT_PARTNER_TONE_LABELS[value],
      })),
      ufs: Object.values(State),
      categoriasAlloyal: await this.alloyalCategoriesCache.obterPorBase(bases),
    };
  }

  /** "HERTZ_SP" → "Hertz Sp" para bases sem rótulo cadastrado. */
  private rotuloBase(base: string): string {
    return base
      .toLowerCase()
      .split('_')
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
  }

  // ------------------------------------------------------- painel §5.1–5.5

  async listarPainel(query: ListDirectPartnersQuery) {
    const isActive = parseBoolean(query.isActive);
    const featured = parseBoolean(query.featured);
    const includeDeleted = parseBoolean(query.includeDeleted) ?? false;

    const where: Prisma.DirectPartnerWhereInput = {
      ...(includeDeleted ? {} : { deletedAt: null }),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(featured !== undefined ? { featured } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.baseOrigin
        ? { bases: { some: { baseOrigin: query.baseOrigin } } }
        : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search } },
              { district: { contains: query.search } },
              { city: { contains: query.search } },
            ],
          }
        : {}),
    };

    const orderBy: Prisma.DirectPartnerOrderByWithRelationInput[] = [
      { [query.orderBy]: query.order },
      { id: 'asc' },
    ];

    const skip = (query.page - 1) * query.limit;
    const { data, total } = await this.repository.listarPainel({
      where,
      orderBy,
      skip,
      take: query.limit,
    });

    const agora = new Date();
    return {
      data: data.map((p) => toAdmin(p, { includeCoupons: false, agora })),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  }

  async detalharPainel(id: number): Promise<DirectPartnerAdmin> {
    const parceiro = await this.obterPainelOu404(id);
    return toAdmin(parceiro, { includeCoupons: true });
  }

  async criar(dto: CreateDirectPartnerDto): Promise<DirectPartnerAdmin> {
    this.validarBases(dto.baseOrigins);
    this.validarHorariosOu422(dto.openingHours);
    const alloyalCategoryIds = this.validarAlloyalCategoryIds(
      dto.alloyalCategoryIds,
    );

    const cupons = (dto.coupons ?? []).map((c) => this.montarCupomCreate(c));
    this.validarCodigosDuplicados(cupons.map((c) => c.code));

    const parceiro = await this.repository.criar({
      data: {
        name: dto.name.trim(),
        shortDescription: dto.shortDescription.trim(),
        description: dto.description?.trim() || null,
        category: dto.category,
        categoryLabel: dto.categoryLabel?.trim() || null,
        alloyalCategoryIds: alloyalCategoryIds ?? Prisma.JsonNull,
        tone: dto.tone ?? DirectPartnerTone.ACCENT,
        ...this.montarEndereco(dto.address),
        ...this.montarContato(dto.contact),
        openingHoursText: dto.openingHoursText?.trim() || null,
        openingHours: dto.openingHours?.length
          ? (dto.openingHours as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        featured: dto.featured ?? false,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      },
      baseOrigins: dto.baseOrigins,
      coupons: cupons,
    });

    this.logger.log(
      `Parceiro direto criado: #${parceiro.id} "${parceiro.name}" bases=${dto.baseOrigins.join(',')}`,
    );
    return toAdmin(parceiro, { includeCoupons: true });
  }

  async atualizar(
    id: number,
    dto: UpdateDirectPartnerDto,
  ): Promise<DirectPartnerAdmin> {
    await this.obterPainelOu404(id);

    if (dto.baseOrigins !== undefined) this.validarBases(dto.baseOrigins);
    if (dto.openingHours !== undefined) {
      this.validarHorariosOu422(dto.openingHours);
    }

    const data: Prisma.DirectPartnerUncheckedUpdateInput = {};

    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.shortDescription !== undefined) {
      data.shortDescription = dto.shortDescription.trim();
    }
    if (dto.description !== undefined) {
      data.description = dto.description?.trim() || null;
    }
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.categoryLabel !== undefined) {
      data.categoryLabel = dto.categoryLabel?.trim() || null;
    }
    if (dto.alloyalCategoryIds !== undefined) {
      data.alloyalCategoryIds =
        this.validarAlloyalCategoryIds(dto.alloyalCategoryIds) ??
        Prisma.JsonNull;
    }
    if (dto.tone !== undefined) data.tone = dto.tone;
    if (dto.address !== undefined)
      Object.assign(data, this.montarEndereco(dto.address));
    if (dto.contact !== undefined)
      Object.assign(data, this.montarContato(dto.contact));
    if (dto.openingHoursText !== undefined) {
      data.openingHoursText = dto.openingHoursText?.trim() || null;
    }
    if (dto.openingHours !== undefined) {
      data.openingHours = dto.openingHours?.length
        ? (dto.openingHours as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull;
    }
    if (dto.featured !== undefined) data.featured = dto.featured;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    const parceiro = await this.repository.atualizar({
      id,
      data,
      baseOrigins: dto.baseOrigins,
    });
    return toAdmin(parceiro, { includeCoupons: true });
  }

  /**
   * Soft delete por padrão (§4.13). `hard=true` remove definitivamente e
   * exige perfil ADMIN do painel (`isPanelAdmin`).
   */
  async excluir(
    id: number,
    hard: boolean,
    isPanelAdmin: boolean,
  ): Promise<void> {
    const parceiro = await this.obterPainelOu404(id);

    if (!hard) {
      await this.repository.excluirSoft(id);
      this.logger.log(`Parceiro direto #${id} excluído (soft)`);
      return;
    }

    if (!isPanelAdmin) {
      throw new ForbiddenException(
        'Exclusão definitiva exige perfil ADMIN do painel',
      );
    }

    await this.repository.excluirDefinitivo(id);
    if (parceiro.logoUrl) {
      await this.fileUploadService.deleteDirectPartnerLogo(parceiro.logoUrl);
    }
    this.logger.warn(`Parceiro direto #${id} excluído definitivamente`);
  }

  async reordenar(ids: number[]): Promise<void> {
    await this.repository.reordenar(ids);
  }

  // ------------------------------------------------------------- logo §5.6

  async salvarLogo(
    id: number,
    arquivo?: Express.Multer.File,
  ): Promise<{ logoUrl: string }> {
    if (!arquivo) {
      throw new BadRequestException(
        'Envie a imagem no campo "logo" (JPG, PNG ou WebP até 2 MB)',
      );
    }
    const parceiro = await this.obterPainelOu404(id);

    const logoUrl = await this.fileUploadService.uploadDirectPartnerLogo(
      arquivo,
      id,
    );
    await this.repository.atualizarLogo(id, logoUrl);

    if (parceiro.logoUrl) {
      await this.fileUploadService.deleteDirectPartnerLogo(parceiro.logoUrl);
    }
    return { logoUrl };
  }

  async removerLogo(id: number): Promise<void> {
    const parceiro = await this.obterPainelOu404(id);
    if (!parceiro.logoUrl) return;
    await this.repository.atualizarLogo(id, null);
    await this.fileUploadService.deleteDirectPartnerLogo(parceiro.logoUrl);
  }

  // ----------------------------------------------------------- cupons §5.8

  async listarCupons(partnerId: number): Promise<DirectPartnerCouponAdmin[]> {
    await this.obterPainelOu404(partnerId);
    const cupons = await this.repository.listarCupons(partnerId);
    const agora = new Date();
    return cupons.map((c) => toAdminCoupon(c, agora));
  }

  async criarCupom(
    partnerId: number,
    dto: CreateDirectPartnerCouponDto,
  ): Promise<DirectPartnerCouponAdmin> {
    await this.obterPainelOu404(partnerId);
    const data = this.montarCupomCreate(dto);
    try {
      const cupom = await this.repository.criarCupom(partnerId, data);
      return toAdminCoupon(cupom);
    } catch (error) {
      throw this.traduzirErroCupom(error, data.code);
    }
  }

  async atualizarCupom(
    partnerId: number,
    couponId: number,
    dto: UpdateDirectPartnerCouponDto,
  ): Promise<DirectPartnerCouponAdmin> {
    const atual = await this.obterCupomOu404(partnerId, couponId);

    const validFrom =
      dto.validFrom !== undefined
        ? parseDataCupom(dto.validFrom)
        : atual.validFrom;
    const validUntil =
      dto.validUntil !== undefined
        ? parseDataCupom(dto.validUntil)
        : atual.validUntil;
    this.validarPeriodo(validFrom, validUntil);

    const data: Prisma.DirectPartnerCouponUncheckedUpdateInput = {};
    if (dto.code !== undefined) data.code = normalizarCodigoCupom(dto.code);
    if (dto.highlight !== undefined) data.highlight = dto.highlight.trim();
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined)
      data.description = dto.description.trim();
    if (dto.conditions !== undefined) {
      data.conditions = dto.conditions.map((c) => c.trim());
    }
    if (dto.validFrom !== undefined) data.validFrom = validFrom;
    if (dto.validUntil !== undefined && validUntil)
      data.validUntil = validUntil;
    if (dto.singleUse !== undefined) data.singleUse = dto.singleUse;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    try {
      const cupom = await this.repository.atualizarCupom(couponId, data);
      return toAdminCoupon(cupom);
    } catch (error) {
      const codigo = typeof data.code === 'string' ? data.code : atual.code;
      throw this.traduzirErroCupom(error, codigo);
    }
  }

  async excluirCupom(partnerId: number, couponId: number): Promise<void> {
    await this.obterCupomOu404(partnerId, couponId);
    await this.repository.excluirCupom(couponId);
  }

  // ------------------------------------------------------------- app §6.1

  async listarApp(baseOrigin: string, query: AppDirectPartnersQuery) {
    const coords = this.resolverCoordenadas(query.lat, query.lng);
    const agora = new Date();

    const where: Prisma.DirectPartnerWhereInput = {
      ...(parseBoolean(query.destaque) ? { featured: true } : {}),
      ...(query.busca
        ? {
            OR: [
              { name: { contains: query.busca } },
              { shortDescription: { contains: query.busca } },
              { district: { contains: query.busca } },
              { categoryLabel: { contains: query.busca } },
            ],
          }
        : {}),
      // Sem alloyalCategoryId, a categoria interna filtra direto no banco;
      // com ele, vira fallback avaliado em memória (§4.8).
      ...(query.categoria && query.alloyalCategoryId === undefined
        ? { category: query.categoria }
        : {}),
    };

    let parceiros = await this.repository.listarApp({
      baseOrigin,
      where,
      agora,
    });

    if (query.alloyalCategoryId !== undefined) {
      const idAlloyal = query.alloyalCategoryId;
      parceiros = parceiros.filter((p) => {
        const ids =
          lerAlloyalCategoryIds(p.alloyalCategoryIds)[baseOrigin] ?? [];
        if (ids.includes(idAlloyal)) return true;
        return query.categoria !== undefined && p.category === query.categoria;
      });
    }

    const sortOrderPorId = new Map(parceiros.map((p) => [p.id, p.sortOrder]));
    const itens: DirectPartnerAppListItem[] = parceiros.map((p) =>
      toAppListItem(p, coords, agora),
    );

    // Ordenação §4.6: featured desc, sortOrder asc, distância asc, nome asc
    itens.sort((a, b) => {
      if (a.destaque !== b.destaque) return a.destaque ? -1 : 1;
      const ordemA = sortOrderPorId.get(a.id) ?? 0;
      const ordemB = sortOrderPorId.get(b.id) ?? 0;
      if (ordemA !== ordemB) return ordemA - ordemB;
      if (coords && a.distanciaKm !== null && b.distanciaKm !== null) {
        if (a.distanciaKm !== b.distanciaKm)
          return a.distanciaKm - b.distanciaKm;
      }
      return a.nome.localeCompare(b.nome, 'pt-BR');
    });

    return {
      data: itens.slice(0, query.limit),
      meta: { total: itens.length, comLocalizacao: coords !== undefined },
    };
  }

  async detalharApp(params: {
    id: number;
    baseOrigin: string;
    userId: number;
    lat?: number;
    lng?: number;
  }): Promise<DirectPartnerAppDetail> {
    const coords = this.resolverCoordenadas(params.lat, params.lng);
    const agora = new Date();
    const parceiro = await this.repository.buscarAppPorId({
      id: params.id,
      baseOrigin: params.baseOrigin,
      agora,
    });
    if (!parceiro) throw new NotFoundException('Parceiro não encontrado');

    const resgates = await this.repository.listarResgatesDoAssociado(
      parceiro.coupons.map((c) => c.id),
      params.userId,
    );
    // Lista vem do mais recente para o mais antigo: o primeiro de cada cupom
    // é o último uso (reutilizável) ou o único resgate (uso único).
    const ultimoPorCupom = new Map<number, Date>();
    for (const r of resgates) {
      if (!ultimoPorCupom.has(r.couponId)) {
        ultimoPorCupom.set(r.couponId, r.redeemedAt);
      }
    }

    return toAppDetail(parceiro, ultimoPorCupom, coords, agora);
  }

  // ------------------------------------------------------------- privados

  private async obterPainelOu404(id: number): Promise<PartnerAdminRecord> {
    const parceiro = await this.repository.buscarPainelPorId(id);
    if (!parceiro) throw new NotFoundException('Parceiro não encontrado');
    return parceiro;
  }

  private async obterCupomOu404(partnerId: number, couponId: number) {
    await this.obterPainelOu404(partnerId);
    const cupom = await this.repository.buscarCupom(partnerId, couponId);
    if (!cupom) throw new NotFoundException('Cupom não encontrado');
    return cupom;
  }

  private resolverCoordenadas(
    lat?: number,
    lng?: number,
  ): Coordenadas | undefined {
    if (lat === undefined && lng === undefined) return undefined;
    if (lat === undefined || lng === undefined) {
      throw new BadRequestException('lat e lng devem ser enviados juntos');
    }
    return { lat, lng };
  }

  private validarBases(bases: string[]): void {
    const invalidas = bases.filter((b) => !isTenantBase(b));
    if (bases.length === 0 || invalidas.length > 0) {
      throw erro422(
        'BASE_INVALIDA',
        bases.length === 0
          ? 'Informe ao menos uma base'
          : `Base desconhecida: ${invalidas.join(', ')}`,
      );
    }
  }

  private validarHorariosOu422(
    horarios: CreateDirectPartnerDto['openingHours'],
  ): void {
    const erro = validarHorarios(horarios ?? null);
    if (erro) throw erro422('HORARIO_INVALIDO', erro);
  }

  /** Chaves precisam ser bases do deploy; valores viram int[] únicos. */
  private validarAlloyalCategoryIds(
    valor: Record<string, number[]> | null | undefined,
  ): Prisma.InputJsonValue | null {
    if (!valor) return null;

    const resultado: Record<string, number[]> = {};
    for (const [base, ids] of Object.entries(valor)) {
      if (!TENANT.baseNames.includes(base)) {
        throw erro422(
          'BASE_INVALIDA',
          `Base desconhecida em alloyalCategoryIds: ${base}`,
        );
      }
      if (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(id))) {
        throw new BadRequestException(
          `alloyalCategoryIds.${base} deve ser uma lista de inteiros`,
        );
      }
      resultado[base] = Array.from(new Set(ids.map(Number)));
    }
    return resultado;
  }

  private validarPeriodo(
    validFrom: Date | null,
    validUntil: Date | null,
  ): void {
    if (!validUntil) {
      throw new BadRequestException('validUntil inválido');
    }
    if (validFrom && validUntil < validFrom) {
      throw erro422(
        'PERIODO_INVALIDO',
        'validUntil não pode ser anterior a validFrom',
      );
    }
  }

  private validarCodigosDuplicados(codigos: string[]): void {
    const vistos = new Set<string>();
    for (const codigo of codigos) {
      if (vistos.has(codigo)) {
        throw erro409(
          'CODIGO_DUPLICADO',
          `Código de cupom repetido: ${codigo}`,
        );
      }
      vistos.add(codigo);
    }
  }

  private montarCupomCreate(
    dto: CreateDirectPartnerCouponDto,
  ): Prisma.DirectPartnerCouponCreateWithoutPartnerInput & { code: string } {
    const validFrom = parseDataCupom(dto.validFrom);
    const validUntil = parseDataCupom(dto.validUntil);
    this.validarPeriodo(validFrom, validUntil);

    return {
      code: normalizarCodigoCupom(dto.code),
      highlight: dto.highlight.trim(),
      title: dto.title.trim(),
      description: dto.description.trim(),
      conditions: dto.conditions.map((c) => c.trim()),
      validFrom,
      validUntil: validUntil as Date,
      singleUse: dto.singleUse ?? false,
      isActive: dto.isActive ?? true,
      sortOrder: dto.sortOrder ?? 0,
    };
  }

  private montarEndereco(address: CreateDirectPartnerDto['address']) {
    return {
      street: address.street.trim(),
      number: address.number?.trim() || null,
      complement: address.complement?.trim() || null,
      district: address.district.trim(),
      city: address.city.trim(),
      state: address.state,
      zipCode: this.formatarCep(address.zipCode),
      reference: address.reference?.trim() || null,
      latitude: address.latitude,
      longitude: address.longitude,
    };
  }

  private montarContato(contact: CreateDirectPartnerDto['contact']) {
    return {
      phone: contact?.phone?.trim() || null,
      whatsapp: contact?.whatsapp?.trim() || null,
      website: contact?.website?.trim() || null,
      instagram: contact?.instagram?.trim() || null,
    };
  }

  /** Persiste sempre como "00000-000". */
  private formatarCep(cep: string): string {
    const digitos = cep.replace(/\D/g, '');
    return `${digitos.slice(0, 5)}-${digitos.slice(5, 8)}`;
  }

  /** Unique (partnerId, code) violado → 409 CODIGO_DUPLICADO. */
  private traduzirErroCupom(error: unknown, code: string): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return erro409(
        'CODIGO_DUPLICADO',
        `Já existe um cupom com o código ${code} neste parceiro`,
      );
    }
    return error;
  }
}
